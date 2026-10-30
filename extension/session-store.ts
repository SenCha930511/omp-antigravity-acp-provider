import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { lock } from "proper-lockfile";
import { resolvePiAgentDir } from "./vendor/pi-antigravity-acp-provider/src/config.ts";

interface SavedSessionRecord {
  piSessionId: string; acpSessionId: string; acpModelId: string; cwd: string;
  messageCount: number; historyFingerprint: string; lastActive: number;
  expectedAssistantFingerprint?: string;
  ompCancelledCheckpoint?: boolean; ompCancelledHadOutput?: boolean;
  ompCheckpointVersion?: 1; ompInFlight?: boolean; ompExpectedAssistantHasOutput?: boolean;
}
const tails = new Map<string, Promise<unknown>>();

// Serialize instances in this process, then merge under the same cross-process
// lock used by older releases. Callers must await writes at checkpoint boundaries.
export class AcpSessionStore {
  readonly file: string;
  constructor(file = path.join(resolvePiAgentDir(), "antigravity-acp-provider", "sessions.json")) {
    this.file = path.resolve(file);
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = (tails.get(this.file) ?? Promise.resolve()).catch(() => {}).then(work);
    tails.set(this.file, result);
    void result.finally(() => { if (tails.get(this.file) === result) tails.delete(this.file); }).catch(() => {});
    return result;
  }
  async flush(): Promise<void> { await tails.get(this.file); }
  // Hold ownership across restoration, prompts and warm idle reuse. The
  // registry write lock alone cannot prevent two processes restoring one ID.
  async acquireSessionLease(id: string, compromised: () => void): Promise<() => Promise<void>> {
    const directory = path.join(path.dirname(this.file), "session-leases");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, createHash("sha256").update(id).digest("hex"));
    try {
      const release = await lock(target, { realpath: false, stale: 30_000, retries: 0, onCompromised: compromised });
      let done: Promise<void> | undefined;
      return () => done ??= release();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new Error("This OMP session is already open in another ACP runtime. Close the other OMP session and retry.");
      throw error;
    }
  }
  get(id: string): Promise<SavedSessionRecord | undefined> {
    return this.enqueue(async () => {
      const records = await this.read(), matches = records.filter(record => record.piSessionId === id);
      if (matches.length !== 1) return undefined;
      const record = matches[0]!;
      // A duplicated/cross-linked mapping proves no exclusive conversation
      // ownership. Reconstruct from OMP instead of picking an arbitrary row.
      if (records.some(other => other !== record && other.acpSessionId === record.acpSessionId)) return undefined;
      return Date.now() - record.lastActive <= 30 * 24 * 60 * 60_000 ? record : undefined;
    });
  }
  list(): Promise<SavedSessionRecord[]> { return this.enqueue(() => this.read()); }
  save(record: SavedSessionRecord): Promise<void> {
    const captured = { ...record };
    return this.update(async () => {
      const existing = await this.read();
      if (existing.some(value => value.piSessionId !== captured.piSessionId && value.acpSessionId === captured.acpSessionId)) {
        throw new Error("ACP session is already mapped to another OMP session; refusing to share conversation state");
      }
      const records = existing.filter(value => value.piSessionId !== captured.piSessionId);
      records.push(captured);
      records.sort((a, b) => b.lastActive - a.lastActive);
      await this.write(records.slice(0, 256));
    });
  }
  remove(id: string): Promise<void> {
    return this.update(async () => this.write((await this.read()).filter(record => record.piSessionId !== id)));
  }
  removeIfMatches(id: string, acpSessionId: string): Promise<boolean> {
    let removed = false;
    return this.update(async () => {
      const records = await this.read();
      removed = records.some(record => record.piSessionId === id && record.acpSessionId === acpSessionId);
      if (removed) await this.write(records.filter(record => record.piSessionId !== id || record.acpSessionId !== acpSessionId));
    }).then(() => removed);
  }
  clear(): Promise<void> { return this.update(() => fs.rm(this.file, { force: true })); }
  private update(work: () => Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const deadline = Date.now() + 5000;
      let compromised: Error | undefined;
      let release: (() => Promise<void>) | undefined;
      for (;;) {
        try {
          release = await lock(this.file, { realpath: false, stale: 30_000, retries: 0,
            onCompromised: (error: Error) => { compromised = error; } });
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error;
          await delay(10);
        }
      }
      try { if (compromised) throw compromised; await work(); if (compromised) throw compromised; }
      finally { await release(); }
    });
  }
  private async read(): Promise<SavedSessionRecord[]> {
    let raw: string;
    try { raw = await fs.readFile(this.file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Invalid ACP session registry; refusing to overwrite it");
    const valid = (record: any): record is SavedSessionRecord => Boolean(record) && typeof record === "object" &&
      ["piSessionId", "acpSessionId", "acpModelId", "cwd", "historyFingerprint"].every(key => typeof record[key] === "string") &&
      Number.isSafeInteger(record.messageCount) && record.messageCount >= 0 && Number.isFinite(record.lastActive) &&
      (record.expectedAssistantFingerprint === undefined || typeof record.expectedAssistantFingerprint === "string") &&
      (record.ompCheckpointVersion === undefined || record.ompCheckpointVersion === 1) &&
      ["ompInFlight", "ompExpectedAssistantHasOutput", "ompCancelledCheckpoint", "ompCancelledHadOutput"].every(key =>
        record[key] === undefined || typeof record[key] === "boolean");
    if (!parsed.every(valid)) throw new Error("Invalid or unsupported ACP session registry record; refusing to overwrite it");
    return parsed;
  }
  private async write(records: SavedSessionRecord[]): Promise<void> {
    if (!records.length) { await fs.rm(this.file, { force: true }); return; }
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(records) + "\n", { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
}
