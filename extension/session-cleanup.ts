import fs from "node:fs";
import afs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { lock } from "proper-lockfile";
import { resolveAntigravityAcpDirectory } from "./vendor/pi-antigravity-acp-provider/src/acp/antigravity.ts";
import { isMissingFileError, writeJsonAtomic } from "./fs-atomic.ts";
import { AcpSessionStore } from "./session-store.ts";
import { sourceRoot, sourceId, findSources, type OmpSessionSource, type OmpSourceScan } from "./omp-session-source.ts";
export type CleanupMode = "off" | "conservative" | "timeout" | "balanced";
export interface CleanupPolicy { mode: CleanupMode; idleDays: number; maxSessions?: number; maxBytes?: number; orphanGraceDays?: number; recoveryDays?: number; batchSize?: number }
const DEFAULT: CleanupPolicy = { mode: "conservative", idleDays: 7 };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
interface Lease { token: string; pid: number; serverPid: number }
interface Record { id: string; owned: boolean; lastUsed: number; leases: Lease[]; retiredFor?: string; replaced?: boolean; disposableAt?: number; disposableFor?: string; confirmedAt?: number; orphanedAt?: number; ompSource?: OmpSessionSource; sourceDeleted?: boolean }
interface Registry { version: 1; sessions: Record[] }
const tails = new Map<string, Promise<unknown>>();
function validate(p: CleanupPolicy): CleanupPolicy {
  if (!p || !["off", "conservative", "timeout", "balanced"].includes(p.mode) || !Number.isFinite(p.idleDays) || p.idleDays < 1 / 24 || p.idleDays > 3650) throw new Error("Cleanup requires off|conservative|timeout|balanced and idleDays between 1/24 and 3650");
  for (const k of ["maxSessions", "maxBytes", "batchSize"] as const) if (p[k] !== undefined && (!Number.isSafeInteger(p[k]) || p[k]! < (k === "batchSize" ? 1 : 0) || (k === "batchSize" && p[k]! > 100))) throw new Error(`Invalid cleanup ${k}`);
  if (p.orphanGraceDays !== undefined && (!Number.isFinite(p.orphanGraceDays) || p.orphanGraceDays < 1 / 24 || p.orphanGraceDays > 3650)) throw new Error("Invalid orphanGraceDays");
  if (p.recoveryDays !== undefined && (!Number.isFinite(p.recoveryDays) || p.recoveryDays < 1 / 24 || p.recoveryDays > 3650)) throw new Error("Invalid recoveryDays");
  return { mode: p.mode, idleDays: p.idleDays, ...Object.fromEntries(["maxSessions", "maxBytes", "orphanGraceDays", "recoveryDays", "batchSize"].filter(k => p[k as keyof CleanupPolicy] !== undefined).map(k => [k, p[k as keyof CleanupPolicy]])) };
}
export function loadCleanupPolicy(file: string): CleanupPolicy { try { return validate(JSON.parse(fs.readFileSync(file, "utf8"))); } catch (e) { if (isMissingFileError(e)) return { ...DEFAULT }; throw e; } }
export function saveCleanupPolicy(file: string, p: CleanupPolicy) { writeJsonAtomic(file, validate(p), false); }
function live(pid: number) { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; } }
const group = (key: string) => createHash("sha256").update(key).digest("hex");

// Ownership, mapped sessions and live leases are protected independently of
// quota. Keep the cross-process lease lock during asynchronous file deletion.
export class SessionCleanup {
  readonly policyPath: string;
  private readonly registryPath: string;
  private readonly sessionStore: AcpSessionStore;
  private timer?: NodeJS.Timeout;
  private nextBatch?: NodeJS.Timeout;
  private collecting?: Promise<number>;
  private readonly touched = new Map<string, number>();
  private readonly intents: Array<(r: Registry) => void> = [];
  // Lock-wait budget clock, kept separate from the constructor's policy
  // clock: advancing retention time must never spend a lock budget, and
  // advancing a lock budget must never age out sessions.
  private acquireRetry: { now: () => number; sleep: (ms: number) => Promise<void> } = {
    now: Date.now,
    sleep: ms => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); }),
  };
  private report = { owned: 0, active: 0, mapped: 0, unmapped: 0, ownedBytes: 0, overBudget: false, removed: 0, reclaimedBytes: 0, retainedForRecovery: 0, failures: 0, deferred: 0 };
  constructor(private readonly stateDir: string, readonly acpDir = resolveAntigravityAcpDirectory(), private readonly now = Date.now, private readonly isLive = live) {
    this.policyPath = path.join(stateDir, "cleanup.json");
    this.sessionStore = new AcpSessionStore(path.join(stateDir, "sessions.json"));
    this.registryPath = path.join(stateDir, `cleanup-sessions-${createHash("sha256").update(path.resolve(acpDir)).digest("hex").slice(0, 16)}.json`);
  }
  configure(mode: CleanupMode, idleDays?: number) {
    const policy = loadCleanupPolicy(this.policyPath);
    saveCleanupPolicy(this.policyPath, { ...policy, mode, idleDays: idleDays ?? (mode === "balanced" ? 7 : policy.idleDays),
      ...(mode === "balanced" ? { maxSessions: policy.maxSessions ?? 50, maxBytes: policy.maxBytes ?? 512 * 1024 * 1024,
        orphanGraceDays: policy.orphanGraceDays ?? 1, recoveryDays: policy.recoveryDays ?? 1 } : {}) });
  }
  budget(maxSessions: number, maxBytes: number) { saveCleanupPolicy(this.policyPath, { ...loadCleanupPolicy(this.policyPath), maxSessions, maxBytes }); }
  async trackSource(id: string, file: string) {
    // A managed root independent of cwd also covers OMP named profiles.
    const root = path.resolve(this.stateDir, "..", "sessions");
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !file.endsWith(".jsonl")) return;
    const stat = await sourceRoot(root);
    if (await sourceId(file) !== id) return;
    await this.transaction(async registry => {
      const mappings = await this.sessionStore.list();
      const mappedAcpIds = new Set(mappings.filter(m => m.piSessionId === id).map(m => m.acpSessionId));
      for (const record of registry.sessions) if (record.owned && mappedAcpIds.has(record.id)) {
        record.ompSource = { id, file: path.resolve(file), root, device: stat.dev, inode: stat.ino };
        delete record.sourceDeleted;
      }
    });
  }
  status() { return { ...loadCleanupPolicy(this.policyPath), ...this.report, warning: this.report.overBudget ? "Soft budget exceeded; active and recently used sessions remain protected" : undefined, pendingLifecycleUpdates: this.intents.length, file: this.policyPath, scope: "adapter-owned local ACP data" }; }
  start() { if (this.timer) return; void this.collect(); this.timer = setInterval(() => { void this.collect(); }, 15 * 60_000); this.timer.unref(); }
  async stop() { clearInterval(this.timer); clearTimeout(this.nextBatch); this.timer = undefined; this.nextBatch = undefined; await this.collecting; await tails.get(this.registryPath)?.catch(() => {}); }
  private transaction<T>(action: (r: Registry) => T | Promise<T>): Promise<T> {
    const pending = (tails.get(this.registryPath) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await afs.mkdir(path.dirname(this.registryPath), { recursive: true, mode: 0o700 });
      const release = await lock(this.registryPath, { realpath: false, stale: 600_000, retries: 0 });
      try {
        let r: Registry = { version: 1, sessions: [] };
        try { r = JSON.parse(await afs.readFile(this.registryPath, "utf8")); } catch (e) { if (!isMissingFileError(e)) throw e; }
        if (r.version !== 1 || !Array.isArray(r.sessions) || !r.sessions.every(v => UUID.test(v.id) && typeof v.owned === "boolean" && Number.isFinite(v.lastUsed) && Array.isArray(v.leases) &&
          (v.replaced === undefined || typeof v.replaced === "boolean") && (v.orphanedAt === undefined || Number.isFinite(v.orphanedAt)) && (v.retiredFor === undefined || /^[a-f0-9]{64}$/.test(v.retiredFor)) &&
          (v.disposableAt === undefined || Number.isFinite(v.disposableAt)) && (v.confirmedAt === undefined || Number.isFinite(v.confirmedAt)) &&
          (v.disposableFor === undefined || (typeof v.disposableFor === "string" && /^[a-f0-9]{64}$/.test(v.disposableFor) && Number.isFinite(v.disposableAt))) &&
          (v.sourceDeleted === undefined || typeof v.sourceDeleted === "boolean") &&
          (v.ompSource === undefined || (typeof v.ompSource.id === "string" && typeof v.ompSource.file === "string" && typeof v.ompSource.root === "string" && Number.isFinite(v.ompSource.device) && Number.isFinite(v.ompSource.inode) && (v.ompSource.missingSince === undefined || Number.isFinite(v.ompSource.missingSince)))) &&
          v.leases.every(l => typeof l.token === "string" && Number.isSafeInteger(l.pid) && l.pid > 0 && Number.isSafeInteger(l.serverPid) && l.serverPid > 0))) throw new Error("Invalid ACP cleanup registry; refusing deletion");
        if (new Set(r.sessions.map(v => v.id.toLowerCase())).size !== r.sessions.length) throw new Error("Duplicate ACP cleanup ownership; refusing deletion");
        const actions = this.intents.slice(); for (const apply of actions) apply(r);
        for (const v of r.sessions) if (this.touched.has(v.id)) v.lastUsed = Math.max(v.lastUsed, this.touched.get(v.id)!);
        const result = await action(r), tmp = this.registryPath + "." + randomUUID() + ".tmp";
        try { await afs.writeFile(tmp, JSON.stringify(r), { mode: 0o600, flag: "wx" }); await afs.rename(tmp, this.registryPath); }
        finally { await afs.rm(tmp, { force: true }); }
        this.intents.splice(0, actions.length);
        const retained = new Set(r.sessions.map(v => v.id));
        for (const id of this.touched.keys()) if (!retained.has(id)) this.touched.delete(id);
        return result;
      } finally { await release(); }
    });
    tails.set(this.registryPath, pending);
    void pending.finally(() => { if (tails.get(this.registryPath) === pending) tails.delete(this.registryPath); }).catch(() => {});
    return pending;
  }
  async acquire(id: string, owned: boolean, serverPid: number, lockWaitMs = 0): Promise<string> {
    if (!UUID.test(id) || !Number.isSafeInteger(serverPid) || serverPid <= 0) throw new Error("Invalid ACP cleanup lease");
    const action = (r: Registry): string => {
      let v = r.sessions.find(v => v.id === id);
      if (!v) { v = { id, owned, lastUsed: this.now(), leases: [] }; r.sessions.push(v); }
      if (v.disposableFor) throw new Error("ACP session was finally released; reconstruct a new session from OMP history");
      const token = randomUUID(); v.leases.push({ token, pid: process.pid, serverPid }); v.lastUsed = this.now(); delete v.orphanedAt;
      this.touched.set(id, v.lastUsed); return token;
    };
    // Only the recovery path passes a budget; every other caller keeps the
    // raw ELOCKED identity and fails fast instead of queueing behind contention.
    const deadline = this.acquireRetry.now() + lockWaitMs;
    for (;;) {
      try { return await this.transaction(action); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || lockWaitMs <= 0) throw error;
        if (this.acquireRetry.now() >= deadline) throw new Error("Timed out acquiring the ACP cleanup lease", { cause: error });
        await this.acquireRetry.sleep(10);
      }
    }
  }
  private async intent(action: (r: Registry) => void) {
    if (this.intents.length >= 1024) throw new Error("Lifecycle retry queue full; preserving files");
    this.intents.push(action); try { await this.transaction(() => {}); } catch (e) { this.report.failures++; throw e; }
  }
  async release(token: string, background = false) { await this.intent(r => { for (const v of r.sessions) v.leases = v.leases.filter(l => l.token !== token); }); if (background) { void this.collect(); return 0; } return this.collect(); }
  async touch(id: string) { const last = this.touched.get(id); this.touched.set(id, this.now()); if (last !== undefined && this.now() - last < 60_000) return; await this.transaction(() => {}); }
  retire(key: string, id: string) { return this.intent(r => { const v = r.sessions.find(v => v.id === id); if (v?.owned) { v.retiredFor = group(key); v.replaced = false; delete v.confirmedAt; } }); }
  async confirm(key: string, replacement: string, background = false) { let confirmed = false; await this.intent(r => { for (const v of r.sessions) if (v.id !== replacement && v.retiredFor === group(key)) { confirmed = true; v.replaced = true; v.confirmedAt ??= this.now(); } }); if (background) { if (confirmed || this.report.deferred > 0) void this.collect(); return 0; } return this.collect(); }
  // OMP explicitly releases one-shot routing IDs after their final request.
  // Never infer disposability from an ID suffix or a generic runtime shutdown.
  async releaseSession(id: string) {
    const mappings = await this.sessionStore.list();
    const released = mappings.filter(m => m.piSessionId === id);
    if (released.length !== 1 || mappings.filter(m => m.acpSessionId === released[0]!.acpSessionId).length !== 1) return;
    await this.intent(registry => {
      for (const mapping of released) {
        const record = registry.sessions.find(v => v.owned && v.id === mapping.acpSessionId);
        if (!record) continue;
        // Persist the recovery marker before unmapping: after a crash either
        // a mapping still protects it, or the marker authorizes later cleanup.
        record.disposableAt ??= this.now();
        record.disposableFor = group(id);
      }
    });
    await this.transaction(registry => this.unmapReleased(registry));
    void this.collect();
  }
  private async unmapReleased(registry: Registry) {
    const mappings = await this.sessionStore.list();
    for (const record of registry.sessions) {
      if (!record.owned || !record.disposableFor || record.leases.some(l => this.isLive(l.pid) || this.isLive(l.serverPid))) continue;
      const matches = mappings.filter(m => m.acpSessionId === record.id);
      if (matches.length !== 1 || group(matches[0]!.piSessionId) !== record.disposableFor ||
        mappings.filter(m => m.piSessionId === matches[0]!.piSessionId).length !== 1) continue;
      for (const match of matches) await this.sessionStore.removeIfMatches(match.piSessionId, record.id);
    }
  }
  collect(): Promise<number> {
    if (this.collecting) return this.collecting;
    const pending = this.collectOnce().catch(() => { this.report.failures++; return 0; }); this.collecting = pending;
    void pending.finally(() => {
      if (this.collecting === pending) this.collecting = undefined;
      if (this.timer && this.report.deferred > 0 && !this.nextBatch) {
        this.nextBatch = setTimeout(() => { this.nextBatch = undefined; void this.collect(); }, 1000); this.nextBatch.unref();
      }
    }); return pending;
  }
  private async collectOnce() {
    const policy = loadCleanupPolicy(this.policyPath);
    return this.transaction(async registry => {
      // Use the same complete validation as checkpoint restoration. An array
      // alone cannot prove that a damaged mapping no longer protects data.
      // Durable final-release evidence also repairs a crash between registry
      // persistence and conditional mapping removal, including in off mode.
      if (registry.sessions.some(v => v.disposableFor)) await this.unmapReleased(registry);
      const mappings = await this.sessionStore.list();
      const mapped = new Set(mappings.map(v => v.acpSessionId));
      const report = { owned: 0, active: 0, mapped: 0, unmapped: 0, ownedBytes: 0, overBudget: false, removed: 0, removedMapped: 0, reclaimedBytes: 0, retainedForRecovery: 0, failures: this.report.failures, deferred: 0 };
      let dirs: { conversations: string; brain: string } | undefined;
      const owned = [];
      const sourceScans = new Map<string, Promise<OmpSourceScan>>();
      for (const v of registry.sessions) {
        v.leases = v.leases.filter(l => this.isLive(l.pid) || this.isLive(l.serverPid)); if (!v.owned) continue;
        if (policy.mode !== "off" && v.ompSource && !v.leases.length) {
          // Re-prove eligibility even when the mapping was removed before a
          // crash, or a previous deletion batch left this record pending.
          delete v.sourceDeleted;
          try {
            const source = v.ompSource, root = path.resolve(this.stateDir, "..", "sessions");
            const relative = path.relative(root, source.file);
            if (source.root !== root || !relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid source scope");
            const stat = await sourceRoot(root);
            if (stat.dev !== source.device || stat.ino !== source.inode) throw new Error("OMP storage changed; preserving session");
            let missing = false;
            try { await afs.lstat(source.file); } catch (e) { if (!isMissingFileError(e)) throw e; missing = true; }
            if (!missing) { delete source.missingSince; }
            else {
              if (!sourceScans.has(root)) sourceScans.set(root, findSources(root));
              const scan = await sourceScans.get(root)!;
              const moved = scan.sources.get(source.id);
              if (moved) { source.file = moved; delete source.missingSince; }
              else if (scan.complete) {
                if (source.missingSince === undefined) source.missingSince = this.now();
                else if (this.now() - source.missingSince >= 60000) {
                  const finalRoot = await sourceRoot(root);
                  if (finalRoot.dev !== source.device || finalRoot.ino !== source.inode) throw new Error("OMP storage changed during scan");
                  let restored = false;
                  try { await afs.lstat(source.file); restored = true; delete source.missingSince; }
                  catch (e) { if (!isMissingFileError(e)) throw e; }
                  if (!restored) {
                    // Recheck under the mapping store's own lock. A newer ACP
                    // binding must never be removed by an old cleanup snapshot.
                    await this.sessionStore.removeIfMatches(source.id, v.id);
                    const latest = await this.sessionStore.list();
                    if (!latest.some(m => m.acpSessionId === v.id)) { mapped.delete(v.id); v.sourceDeleted = true; }
                  }
                }
              }
            }
          } catch { report.failures++; }
        }
        report.owned++; if (v.leases.length) report.active++;
        if (mapped.has(v.id)) { report.mapped++; delete v.orphanedAt; } else { report.unmapped++; v.orphanedAt ??= this.now(); }
        let size = 0; try { dirs ??= await this.verifyRoot(); for (const target of this.targets(v.id, dirs)) size += await this.inspect(target); } catch { report.failures++; }
        report.ownedBytes += size; owned.push({ v, size });
      }
      const over = () => Boolean((policy.maxSessions && report.owned > policy.maxSessions) || (policy.maxBytes && report.ownedBytes > policy.maxBytes));
      report.overBudget = over();
      if (policy.mode !== "off") for (const { v, size } of owned.sort((a, b) => a.v.lastUsed - b.v.lastUsed)) {
        if (v.leases.length) continue;
        const isMapped = mapped.has(v.id);
        // Balanced mode may retire a still-mapped conversation once it has been
        // idle for the full window; the next turn rebuilds it from OMP history.
        // Every other mode, and every shorter idle period, preserves mappings.
        const mappedExpired = isMapped && policy.mode === "balanced" && this.now() - v.lastUsed >= policy.idleDays * 86_400_000;
        if (isMapped && !mappedExpired) continue;
        const recoverable = v.replaced || v.disposableAt !== undefined;
        // Legacy replacement records start their recovery window on the first
        // balanced sweep. Pressure never bypasses that minimum retention.
        if (policy.mode === "balanced" && v.replaced) v.confirmedAt ??= this.now();
        const recovering = policy.mode === "balanced" && recoverable && this.now() - Math.max(v.confirmedAt ?? 0, v.disposableAt ?? 0, v.lastUsed) < (policy.recoveryDays ?? 1) * 86_400_000;
        if (recovering && !v.sourceDeleted) { report.retainedForRecovery++; continue; }
        const timeout = policy.mode === "timeout" || policy.mode === "balanced";
        const idleSince = policy.mode === "balanced" ? Math.max(v.lastUsed, v.orphanedAt ?? 0) : v.lastUsed;
        const expired = timeout && (this.now() - idleSince >= policy.idleDays * 86_400_000 ||
          (over() && v.orphanedAt !== undefined && this.now() - v.orphanedAt >= (policy.orphanGraceDays ?? 1) * 86_400_000));
        if (!recoverable && !v.sourceDeleted && !expired && !mappedExpired) continue;
        if (report.removed >= (policy.batchSize ?? 8)) { report.deferred++; continue; }
        try {
          if (isMapped) {
            // Re-prove ownership under the mapping store's lock before deleting
            // files. Ambiguous or duplicated mappings prove nothing, and a
            // concurrent resume that re-mapped this ACP ID wins; either way the
            // sweep leaves the session for its owner.
            const rows = mappings.filter(m => m.acpSessionId === v.id);
            const owner = rows.length === 1 ? rows[0]!.piSessionId : undefined;
            if (owner === undefined || mappings.filter(m => m.piSessionId === owner).length !== 1) continue;
            await this.sessionStore.removeIfMatches(owner, v.id);
            if ((await this.sessionStore.list()).some(m => m.acpSessionId === v.id)) { report.failures++; continue; }
            mapped.delete(v.id);
          }
          dirs ??= await this.verifyRoot(); const targets = this.targets(v.id, dirs);
          for (const target of targets) await this.inspect(target);
          for (const target of targets) await afs.rm(target, { recursive: true, force: true });
          registry.sessions = registry.sessions.filter(r => r !== v); this.touched.delete(v.id);
          report.removed++; report.owned--; report.ownedBytes -= size; report.reclaimedBytes += size;
          if (isMapped) { report.mapped--; report.removedMapped++; } else report.unmapped--;
        } catch { report.failures++; }
      }
      registry.sessions = registry.sessions.filter(v => v.owned || v.leases.length);
      report.overBudget = over(); this.report = report; return report.removed;
    });
  }
  private targets(id: string, d: { conversations: string; brain: string }) { return [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"].map(s => path.join(d.conversations, id + s)).concat(path.join(d.brain, id)); }
  private async verifyRoot() {
    const root = path.resolve(this.acpDir); if (await afs.realpath(root) !== root) throw new Error("Symlinked ACP root");
    const dirs = { conversations: path.join(root, "conversations"), brain: path.join(root, "brain") };
    for (const d of Object.values(dirs)) try { if (await afs.realpath(d) !== d) throw new Error("Symlinked cleanup directory"); } catch (e) { if (!isMissingFileError(e)) throw e; }
    return dirs;
  }
  private async inspect(file: string): Promise<number> {
    let s: import("node:fs").Stats; try { s = await afs.lstat(file); } catch (e) { if (isMissingFileError(e)) return 0; throw e; }
    if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) throw new Error("Unsafe cleanup target");
    if (!s.isDirectory()) return s.size;
    let size = 0; for (const f of await afs.readdir(file)) size += await this.inspect(path.join(file, f)); return size;
  }
}
