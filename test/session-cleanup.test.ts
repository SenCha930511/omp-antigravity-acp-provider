import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { SessionCleanup, saveCleanupPolicy } from "../extension/session-cleanup.ts";
import { AcpSessionStore } from "../extension/session-store.ts";

function fixture(t: any) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-acp-cleanup-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 1_000_000;
  const living = new Set([process.pid, 987654]);
  const acp = path.join(root, "acp");
  fs.mkdirSync(path.join(acp, "conversations"), { recursive: true });
  const create = () => new SessionCleanup(path.join(root, "state"), acp, () => now, pid => living.has(pid));
  const cleaner = create();
  function session() {
    const id = randomUUID();
    for (const suffix of [".db", ".meta", ".db-wal", ".db-shm", ".db-journal"]) fs.writeFileSync(path.join(acp, "conversations", id + suffix), "fixture");
    fs.mkdirSync(path.join(acp, "brain", id, "mcp"), { recursive: true });
    fs.writeFileSync(path.join(acp, "brain", id, "mcp", "tool.json"), "{}");
    return id;
  }
  const exists = (id: string) => fs.existsSync(path.join(acp, "conversations", `${id}.db`));
  return { root, acp, cleaner, create, session, exists, living, advance: (days: number) => { now += days * 86_400_000; } };
}

async function trackedSource(f: any, id: string) {
  const root = path.join(f.root, "sessions"), file = path.join(root, "workspace", "chat.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: "session", id: "omp-chat" }) + "\n");
  const mappingFile = path.join(f.root, "state", "sessions.json");
  fs.writeFileSync(mappingFile, JSON.stringify([{ piSessionId: "omp-chat", acpSessionId: id, acpModelId: "flash", cwd: f.root, messageCount: 1, historyFingerprint: "test", lastActive: Date.now() }]));
  await f.cleaner.trackSource("omp-chat", file);
  return { root, file, mappingFile };
}

test("deleted OMP source removes its mapping and owned ACP files only after two checks and lease release", async t => {
  const f = fixture(t), id = f.session();
  const token = await f.cleaner.acquire(id, true, 987654);
  const source = await trackedSource(f, id);
  fs.unlinkSync(source.file);
  f.advance(1); await f.cleaner.collect(); assert.ok(f.exists(id), "live lease protects deleted source");
  await f.cleaner.release(token); assert.ok(f.exists(id), "first missing observation only");
  f.advance(30 / 86400); await f.cleaner.collect(); assert.ok(f.exists(id), "less than one minute");
  f.advance(31 / 86400); assert.equal(await f.create().collect(), 1, "observation survives process restart");
  assert.equal(f.exists(id), false); assert.equal(fs.existsSync(source.mappingFile), false);
});

test("closing, moving, restoring or unmounting an OMP source never proves deletion", async t => {
  const f = fixture(t), id = f.session();
  const token = await f.cleaner.acquire(id, true, 987654);
  const source = await trackedSource(f, id);
  await f.cleaner.release(token); f.advance(10); await f.cleaner.collect(); assert.ok(f.exists(id));
  const moved = path.join(source.root, "other", "renamed.jsonl");
  fs.mkdirSync(path.dirname(moved)); fs.renameSync(source.file, moved);
  await f.cleaner.collect(); f.advance(1); await f.cleaner.collect(); assert.ok(f.exists(id), "search finds moved header id");
  fs.unlinkSync(moved); await f.cleaner.collect();
  fs.writeFileSync(moved, JSON.stringify({ type: "session", id: "omp-chat" }) + "\n");
  f.advance(1); await f.cleaner.collect(); assert.ok(f.exists(id), "restoration cancels pending deletion");
  fs.renameSync(source.root, source.root + "-offline");
  f.advance(1); await f.cleaner.collect(); assert.ok(f.exists(id), "missing volume/root fails closed");
  assert.ok(fs.existsSync(source.mappingFile));
});

test("off preserves deleted OMP sources and malformed relocation scans fail closed", async t => {
  const f = fixture(t), id = f.session();
  const token = await f.cleaner.acquire(id, true, 987654);
  const source = await trackedSource(f, id);
  f.cleaner.configure("off"); fs.unlinkSync(source.file); await f.cleaner.release(token);
  f.advance(10); await f.cleaner.collect(); assert.ok(f.exists(id)); assert.ok(fs.existsSync(source.mappingFile));
  f.cleaner.configure("conservative");
  fs.writeFileSync(path.join(source.root, "broken.jsonl"), "not-json");
  await f.cleaner.collect(); f.advance(10); await f.cleaner.collect(); assert.ok(f.exists(id));
  assert.ok(f.cleaner.status().failures > 0);
});

test("deleted-source reconciliation recovers after mapping removal without losing ownership proof", async t => {
  const f = fixture(t), id = f.session();
  const token = await f.cleaner.acquire(id, true, 987654);
  const source = await trackedSource(f, id);
  fs.unlinkSync(source.file); await f.cleaner.release(token);
  // Simulate the cross-file crash boundary: source evidence is durable, the
  // mapping disappeared, but the registry's deletion flag was not committed.
  fs.unlinkSync(source.mappingFile);
  f.advance(61 / 86400);
  assert.equal(await f.create().collect(), 1); assert.equal(f.exists(id), false);
});

test("an old mapping without a verified journal source is never inferred deleted", async t => {
  const f = fixture(t), id = f.session();
  const token = await f.cleaner.acquire(id, true, 987654);
  fs.writeFileSync(path.join(f.root, "state", "sessions.json"), JSON.stringify([{
    piSessionId: "unknown", acpSessionId: id, acpModelId: "flash", cwd: f.root,
    messageCount: 1, historyFingerprint: "test", lastActive: Date.now(),
  }]));
  await f.cleaner.release(token); f.advance(100); await f.cleaner.collect();
  assert.ok(f.exists(id));
  assert.equal(f.cleaner.status().mapped, 1, "A valid legacy mapping is protected without deletion-source evidence");
  assert.equal(f.cleaner.status().failures, 0);
});

test("conservative cleanup waits for successful replacement AND old process release", async t => {
  const f = fixture(t); const old = f.session(), next = f.session();
  const lease = await f.cleaner.acquire(old, true, 987654);
  await f.cleaner.retire("sid:chat", old);
  await f.cleaner.release(lease);
  assert.ok(f.exists(old), "failed/uncompleted replacement must preserve old data");
  const secondLease = await f.cleaner.acquire(old, false, 987654);
  await f.cleaner.confirm("sid:chat", next);
  assert.ok(f.exists(old), "live old connection must block removal");
  await f.cleaner.release(secondLease);
  assert.equal(f.exists(old), false);
  assert.equal(fs.existsSync(path.join(f.acp, "brain", old)), false);
  assert.ok(f.exists(next));
  assert.deepEqual(fs.readdirSync(path.join(f.acp, "conversations")).sort(), [".db", ".db-journal", ".db-shm", ".db-wal", ".meta"].map(s => next + s).sort());
});

test("off defers even confirmed superseded data; switching back retries", async t => {
  const f = fixture(t); f.cleaner.configure("off"); const id = f.session();
  const token = await f.cleaner.acquire(id, true, 987654);
  await f.cleaner.retire("chat", id); await f.cleaner.confirm("chat", randomUUID()); await f.cleaner.release(token);
  assert.ok(f.exists(id));
  f.cleaner.configure("conservative"); assert.equal(await f.cleaner.collect(), 1);
});

test("idle/resumable sessions survive conservative mode; timeout uses configured last activity", async t => {
  const f = fixture(t); const id = f.session();
  const token = await f.cleaner.acquire(id, true, 987654); await f.cleaner.release(token);
  f.advance(100); assert.equal(await f.cleaner.collect(), 0);
  f.cleaner.configure("timeout", 7); await f.cleaner.touch(id);
  f.advance(6); assert.equal(await f.cleaner.collect(), 0);
  f.advance(1); assert.equal(await f.cleaner.collect(), 1);
  assert.equal(f.exists(id), false);
});

test("independent instances share leases; parent OR server process protects a session", async t => {
  const f = fixture(t); const id = f.session();
  await f.cleaner.acquire(id, true, 987654);
  const peer = f.create(); peer.configure("timeout", 1); f.advance(2);
  f.living.delete(process.pid); assert.equal(await peer.collect(), 0, "surviving supervisor still protects data");
  f.living.add(process.pid); f.living.delete(987654); assert.equal(await peer.collect(), 0, "live OMP still protects data");
  f.living.delete(process.pid); assert.equal(await peer.collect(), 1);
});

test("unregistered and resumed legacy sessions are never adopted for deletion", async t => {
  const f = fixture(t); const unregistered = f.session(), legacy = f.session();
  const token = await f.cleaner.acquire(legacy, false, 987654); await f.cleaner.release(token);
  await f.cleaner.retire("chat", legacy); await f.cleaner.confirm("chat", randomUUID());
  f.cleaner.configure("timeout", 1); f.advance(100); await f.cleaner.collect();
  assert.ok(f.exists(unregistered)); assert.ok(f.exists(legacy));
});

test("only matching OMP replacement group can confirm retirement; cancelled replacement cannot confirm itself", async t => {
  const f = fixture(t); const id = f.session();
  const token = await f.cleaner.acquire(id, true, 987654); await f.cleaner.retire("chat-A", id); await f.cleaner.release(token);
  await f.cleaner.confirm("chat-B", randomUUID()); await f.cleaner.confirm("chat-A", id);
  assert.ok(f.exists(id)); await f.cleaner.confirm("chat-A", randomUUID()); assert.equal(f.exists(id), false);
});

test("symlinked artifacts or parent directories preserve all session files and external data", async t => {
  const f = fixture(t); const id = f.session();
  const external = path.join(f.root, "keep.txt"); fs.writeFileSync(external, "keep");
  fs.symlinkSync(external, path.join(f.acp, "brain", id, "link"));
  const token = await f.cleaner.acquire(id, true, 987654); await f.cleaner.retire("chat", id); await f.cleaner.confirm("chat", randomUUID()); await f.cleaner.release(token);
  assert.ok(f.exists(id)); assert.equal(fs.readFileSync(external, "utf8"), "keep");
  fs.unlinkSync(path.join(f.acp, "brain", id, "link"));
  fs.renameSync(path.join(f.acp, "conversations"), path.join(f.root, "external-conversations"));
  fs.symlinkSync(path.join(f.root, "external-conversations"), path.join(f.acp, "conversations"));
  assert.equal(await f.cleaner.collect(), 0); assert.ok(f.exists(id));
});

test("invalid UUID/settings, corrupted registry, and busy locks fail closed", async t => {
  const f = fixture(t);
  await assert.rejects(async () => await f.cleaner.acquire("../../credentials", true, 987654));
  for (const days of [0, NaN, 4000]) assert.throws(() => f.cleaner.configure("timeout", days));
  assert.throws(() => f.cleaner.configure("typo" as any));
  const id = f.session(); const token = await f.cleaner.acquire(id, true, 987654); await f.cleaner.release(token);
  const state = path.join(f.root, "state");
  const file = path.join(state, fs.readdirSync(state).find(n => n.startsWith("cleanup-sessions-"))!);
  fs.mkdirSync(file + ".lock");
  assert.equal(await f.cleaner.collect(), 0);
  await assert.rejects(async () => await f.cleaner.acquire(id, false, 987654));
  fs.rmdirSync(file + ".lock"); fs.writeFileSync(file, "broken");
  assert.equal(await f.cleaner.collect(), 0); assert.ok(f.exists(id));
});

test("throttled touch skips redundant disk writes within throttle window and flushes before collect", async t => {
  const f = fixture(t);
  f.cleaner.configure("timeout", 1);
  const id = f.session();
  const token = await f.cleaner.acquire(id, true, 987654);
  await f.cleaner.release(token);
  const state = path.join(f.root, "state");
  const file = path.join(state, fs.readdirSync(state).find(n => n.startsWith("cleanup-sessions-"))!);
  f.advance(0.0001); // ~8.64 seconds (< 60s throttle window)
  fs.mkdirSync(file + ".lock");
  // Within throttle window, touch() updates in-memory pendingTouches without acquiring disk lock
  await f.cleaner.touch(id);
  fs.rmdirSync(file + ".lock");
  // Advance just short of 1 day from the throttled touch; collect() flushes pendingTouches so session survives
  f.advance(0.99995);
  assert.equal(await f.cleaner.collect(), 0);
  assert.ok(f.exists(id));
  f.advance(0.0002);
  assert.equal(await f.cleaner.collect(), 1);
  assert.equal(f.exists(id), false);
});

test("quota warns in conservative mode; timeout evicts only idle unmapped owned data after grace", async t => {
  const f = fixture(t), mapped = f.session(), active = f.session(), orphan = f.session(), foreign = f.session(), unknown = f.session();
  for (const id of [mapped, orphan]) { const token = await f.cleaner.acquire(id, true, 987654); await f.cleaner.release(token); }
  await f.cleaner.acquire(active, true, 987654);
  const token = await f.cleaner.acquire(foreign, false, 987654); await f.cleaner.release(token);
  fs.writeFileSync(path.join(f.root, "state/sessions.json"), JSON.stringify([{
    piSessionId: "mapped", acpSessionId: mapped, acpModelId: "flash", cwd: f.root,
    messageCount: 1, historyFingerprint: "test", lastActive: Date.now(),
  }]));
  f.cleaner.budget(1, 1);
  assert.equal(await f.cleaner.collect(), 0); assert.equal(f.cleaner.status().overBudget, true);
  f.cleaner.configure("timeout", 100); f.advance(2);
  assert.equal(await f.cleaner.collect(), 1);
  assert.equal(f.exists(orphan), false);
  for (const id of [mapped, active, foreign, unknown]) assert.ok(f.exists(id));
  assert.equal(f.cleaner.status().overBudget, true, "Protected sessions can exceed a soft budget");
});

test("confirmed cleanup is batched and lifecycle lock failures are retried without adopting data", async t => {
  const f = fixture(t); f.cleaner.configure("off");
  const ids = Array.from({ length: 5 }, () => f.session());
  for (const id of ids) { const token = await f.cleaner.acquire(id, true, 987654); await f.cleaner.retire("batch", id); await f.cleaner.release(token); }
  await f.cleaner.confirm("batch", randomUUID());
  saveCleanupPolicy(f.cleaner.policyPath, { mode: "conservative", idleDays: 7, batchSize: 2 });
  assert.equal(await f.cleaner.collect(), 2); assert.equal(f.cleaner.status().deferred, 3);
  assert.equal(await f.cleaner.collect(), 2); assert.equal(await f.cleaner.collect(), 1);
  const id = f.session(), token = await f.cleaner.acquire(id, true, 987654);
  const state = path.join(f.root, "state"), file = path.join(state, fs.readdirSync(state).find(f => f.startsWith("cleanup-sessions-"))!);
  fs.mkdirSync(file + ".lock");
  await assert.rejects(f.cleaner.retire("retry", id));
  assert.equal(f.cleaner.status().pendingLifecycleUpdates, 1); fs.rmdirSync(file + ".lock");
  await f.cleaner.collect(); assert.equal(f.cleaner.status().pendingLifecycleUpdates, 0);
  await f.cleaner.confirm("retry", randomUUID()); await f.cleaner.release(token); assert.equal(f.exists(id), false);
});

test("malformed mappings block deletion and asynchronous directory inspection yields to timers", async t => {
  const f = fixture(t), id = f.session();
  const token = await f.cleaner.acquire(id, true, 987654); await f.cleaner.release(token);
  f.cleaner.configure("timeout", 1); f.advance(2);
  fs.writeFileSync(path.join(f.root, "state/sessions.json"), "broken");
  assert.equal(await f.cleaner.collect(), 0); assert.ok(f.exists(id));
  fs.unlinkSync(path.join(f.root, "state/sessions.json"));
  for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(f.acp, "brain", id, String(i)), "fixture");
  let tick = false; const timer = setTimeout(() => { tick = true; }, 0);
  assert.equal(await f.cleaner.collect(), 1); clearTimeout(timer); assert.equal(tick, true);
});

test("malformed individual mapping records preserve every cleanup candidate", async t => {
  const f = fixture(t), id = f.session();
  const token = await f.cleaner.acquire(id, true, 987654);
  await f.cleaner.release(token);
  f.cleaner.configure("timeout", 1); f.advance(2);
  const file = path.join(f.root, "state/sessions.json");
  for (const record of [{}, { piSessionId: "chat" }, { piSessionId: "chat", acpSessionId: 42 }, null]) {
    fs.writeFileSync(file, JSON.stringify([record]));
    assert.equal(await f.cleaner.collect(), 0);
    assert.ok(f.exists(id), "Uncertain mappings must block deletion");
  }
});

test("cleanup forgets activity entries after unowned lease records are removed", async t => {
  const f = fixture(t);
  for (let i = 0; i < 8; i++) {
    const token = await f.cleaner.acquire(randomUUID(), false, 987654);
    await f.cleaner.release(token);
  }
  assert.equal((f.cleaner as any).touched.size, 0);
});

test("balanced preset keeps existing modes and explicit budgets, and validates recovery retention", t => {
  const f = fixture(t);
  assert.equal(f.cleaner.status().mode, "conservative");
  f.cleaner.configure("timeout", 0.5);
  f.cleaner.configure("balanced");
  assert.equal(f.cleaner.status().idleDays, 7);
  assert.equal(f.cleaner.status().recoveryDays, 1);
  assert.equal(f.cleaner.status().maxSessions, 50);
  assert.equal(f.cleaner.status().maxBytes, 512 * 1024 * 1024);
  f.cleaner.budget(0, 123);
  f.cleaner.configure("balanced", 14);
  assert.equal(f.cleaner.status().maxSessions, 0);
  assert.equal(f.cleaner.status().maxBytes, 123);
  assert.equal(f.cleaner.status().idleDays, 14);
  for (const recoveryDays of [0, -1, NaN, 3651]) {
    assert.throws(() => saveCleanupPolicy(f.cleaner.policyPath, { mode: "balanced", idleDays: 7, recoveryDays }), /recoveryDays/);
  }
});

test("balanced reclaims mapped and orphaned conversations only after the full idle window", async t => {
  const f = fixture(t), idle = f.session(), orphan = f.session(), leased = f.session(), unknown = f.session();
  const store = new AcpSessionStore(path.join(f.root, "state/sessions.json"));
  const idleToken = await f.cleaner.acquire(idle, true, 987654);
  const orphanToken = await f.cleaner.acquire(orphan, true, 987654);
  const leasedToken = await f.cleaner.acquire(leased, true, 987654);
  for (const [piSessionId, acpSessionId] of [["idle-chat", idle], ["leased-chat", leased]]) await store.save({
    piSessionId, acpSessionId, acpModelId: "flash", cwd: f.root, messageCount: 1, historyFingerprint: "test", lastActive: Date.now(),
  });
  await f.cleaner.release(idleToken); await f.cleaner.release(orphanToken);
  f.cleaner.configure("balanced");
  f.advance(6.99);
  assert.equal(await f.cleaner.collect(), 0, "Mapped and orphaned history survives until the full idle window ends");
  assert.equal((await store.get("idle-chat"))?.acpSessionId, idle);
  f.advance(0.01);
  assert.equal(await f.cleaner.collect(), 2);
  assert.equal(f.exists(idle), false); assert.equal(f.exists(orphan), false);
  assert.equal(await store.get("idle-chat"), undefined, "The stale mapping is removed before its files");
  assert.equal(f.cleaner.status().removedMapped, 1);
  assert.equal(f.cleaner.status().reclaimedBytes, 74);
  assert.ok(f.exists(leased), "A live lease protects mapped history regardless of idle time");
  assert.equal(await f.cleaner.release(leasedToken), 1, "The last user releasing starts normal idle accounting");
  assert.equal(f.exists(leased), false);
  assert.ok(f.exists(unknown));
});

test("conservative and timeout modes never reclaim mapped history", async t => {
  const f = fixture(t), id = f.session();
  const store = new AcpSessionStore(path.join(f.root, "state/sessions.json"));
  const token = await f.cleaner.acquire(id, true, 987654);
  await store.save({ piSessionId: "chat", acpSessionId: id, acpModelId: "flash", cwd: f.root,
    messageCount: 1, historyFingerprint: "test", lastActive: Date.now() });
  await f.cleaner.release(token);
  f.advance(100);
  assert.equal(await f.cleaner.collect(), 0, "Conservative keeps mapped conversations");
  f.cleaner.configure("timeout", 1);
  assert.equal(await f.cleaner.collect(), 0, "Timeout keeps mapped conversations");
  f.cleaner.configure("balanced");
  assert.equal(await f.cleaner.collect(), 1);
  assert.equal(await store.get("chat"), undefined); assert.equal(f.exists(id), false);
});

test("balanced replacement recovery survives restart, repeated confirmations and quota pressure", async t => {
  const f = fixture(t), id = f.session();
  f.cleaner.configure("balanced"); f.cleaner.budget(0, 1);
  const token = await f.cleaner.acquire(id, true, 987654);
  await f.cleaner.retire("chat", id); await f.cleaner.confirm("chat", randomUUID());
  await f.cleaner.release(token);
  assert.ok(f.exists(id)); assert.equal(f.cleaner.status().retainedForRecovery, 1);
  f.advance(0.75); await f.cleaner.confirm("chat", randomUUID());
  f.advance(0.25); assert.equal(await f.create().collect(), 1, "Repeated confirmations must not extend retention indefinitely");
  assert.equal(f.exists(id), false);
});

test("explicit final release unmaps only owned one-shot state and balanced mode keeps a recovery copy", async t => {
  const f = fixture(t), id = f.session(), main = f.session();
  f.cleaner.configure("balanced");
  const token = await f.cleaner.acquire(id, true, 987654);
  const mainToken = await f.cleaner.acquire(main, true, 987654);
  const store = new AcpSessionStore(path.join(f.root, "state/sessions.json"));
  for (const [piSessionId, acpSessionId] of [["side", id], ["main", main]]) await store.save({
    piSessionId, acpSessionId, acpModelId: "flash", cwd: f.root, messageCount: 1, historyFingerprint: "test", lastActive: Date.now(),
  });
  await f.cleaner.releaseSession("side"); await f.cleaner.collect();
  assert.equal((await store.get("side"))?.acpSessionId, id, "Live users keep the mapping until teardown completes");
  assert.equal((await store.get("main"))?.acpSessionId, main);
  f.advance(2); assert.equal(await f.cleaner.collect(), 0, "Live users override disposable eligibility");
  await f.cleaner.release(token); assert.equal(f.exists(id), false);
  assert.equal(await store.get("side"), undefined);
  await f.cleaner.release(mainToken); f.advance(1); await f.cleaner.collect(); assert.ok(f.exists(main));
});

test("one-shot recovery starts at final release and off mode preserves its files", async t => {
  const f = fixture(t), id = f.session();
  f.cleaner.configure("off");
  const token = await f.cleaner.acquire(id, true, 987654);
  const store = new AcpSessionStore(path.join(f.root, "state/sessions.json"));
  await store.save({ piSessionId: "side", acpSessionId: id, acpModelId: "flash", cwd: f.root,
    messageCount: 1, historyFingerprint: "test", lastActive: Date.now() });
  await f.cleaner.release(token); f.advance(10);
  await f.cleaner.releaseSession("side"); await f.cleaner.collect(); assert.ok(f.exists(id));
  f.cleaner.configure("balanced");
  f.advance(0.99); assert.equal(await f.cleaner.collect(), 0);
  f.advance(0.01); assert.equal(await f.create().collect(), 1);
});

test("final release preserves unregistered and ambiguously shared ACP mappings", async t => {
  const f = fixture(t), unknown = f.session(), shared = f.session();
  const token = await f.cleaner.acquire(shared, true, 987654); await f.cleaner.release(token);
  const file = path.join(f.root, "state/sessions.json"), store = new AcpSessionStore(file);
  const mapping = (piSessionId: string, acpSessionId: string) => ({ piSessionId, acpSessionId, acpModelId: "flash", cwd: f.root,
    messageCount: 1, historyFingerprint: "test", lastActive: Date.now() });
  fs.writeFileSync(file, JSON.stringify([mapping("side", unknown), mapping("side", shared), mapping("other", shared)]));
  await f.cleaner.releaseSession("side"); await f.cleaner.collect();
  assert.equal((await store.list()).length, 3);
  assert.ok(f.exists(shared)); assert.ok(f.exists(unknown));
});

test("final release cannot erase a newer mapping installed after its ownership snapshot", async t => {
  const f = fixture(t), old = f.session(), newer = f.session();
  f.cleaner.configure("balanced");
  const token = await f.cleaner.acquire(old, true, 987654); await f.cleaner.release(token);
  const store = new AcpSessionStore(path.join(f.root, "state/sessions.json"));
  const mapping = { piSessionId: "side", acpSessionId: old, acpModelId: "flash", cwd: f.root,
    messageCount: 1, historyFingerprint: "test", lastActive: Date.now() };
  await store.save(mapping);
  const inner = (f.cleaner as any).sessionStore, read = inner.list.bind(inner); let calls = 0;
  inner.list = async () => {
    if (++calls === 2) await store.save({ ...mapping, acpSessionId: newer });
    return read();
  };
  await f.cleaner.releaseSession("side"); await f.cleaner.collect();
  assert.equal((await store.get("side"))?.acpSessionId, newer);
  assert.ok(f.exists(newer)); assert.ok(f.exists(old));
});

test("a persisted final-release marker repairs interrupted unmapping after process restart", async t => {
  const f = fixture(t), id = f.session();
  f.cleaner.configure("balanced");
  const token = await f.cleaner.acquire(id, true, 987654); await f.cleaner.release(token);
  const store = new AcpSessionStore(path.join(f.root, "state/sessions.json"));
  await store.save({ piSessionId: "side", acpSessionId: id, acpModelId: "flash", cwd: f.root,
    messageCount: 1, historyFingerprint: "test", lastActive: Date.now() });
  (f.cleaner as any).sessionStore.removeIfMatches = async () => { throw new Error("synthetic crash before unmapping"); };
  await assert.rejects(f.cleaner.releaseSession("side"), /synthetic crash/);
  assert.equal((await store.get("side"))?.acpSessionId, id);
  const restarted = f.create();
  await assert.rejects(restarted.acquire(id, false, 987654), /finally released/);
  assert.equal(await restarted.collect(), 0, "Recovery copy is retained across the interrupted cleanup");
  assert.equal(await store.get("side"), undefined); assert.ok(f.exists(id));
  f.advance(1); assert.equal(await restarted.collect(), 1);
});

test("contended final release retries its intent and preserves the balanced recovery window", async t => {
  const f = fixture(t), id = f.session();
  f.cleaner.configure("balanced");
  const token = await f.cleaner.acquire(id, true, 987654); await f.cleaner.release(token);
  const store = new AcpSessionStore(path.join(f.root, "state/sessions.json"));
  await store.save({ piSessionId: "side", acpSessionId: id, acpModelId: "flash", cwd: f.root,
    messageCount: 1, historyFingerprint: "test", lastActive: Date.now() });
  const state = path.join(f.root, "state");
  const file = path.join(state, fs.readdirSync(state).find(n => n.startsWith("cleanup-sessions-"))!);
  fs.mkdirSync(file + ".lock");
  await assert.rejects(f.cleaner.releaseSession("side"));
  assert.equal(f.cleaner.status().pendingLifecycleUpdates, 1);
  fs.rmdirSync(file + ".lock");
  await f.cleaner.collect();
  assert.equal(await store.get("side"), undefined); assert.ok(f.exists(id));
  assert.equal(f.cleaner.status().pendingLifecycleUpdates, 0);
});

test("duplicate OMP identities cannot authorize final-release deletion of either owned session", async t => {
  const f = fixture(t), ids = [f.session(), f.session()];
  for (const id of ids) { const token = await f.cleaner.acquire(id, true, 987654); await f.cleaner.release(token); }
  const file = path.join(f.root, "state/sessions.json");
  fs.writeFileSync(file, JSON.stringify(ids.map(acpSessionId => ({ piSessionId: "side", acpSessionId, acpModelId: "flash", cwd: f.root,
    messageCount: 1, historyFingerprint: "test", lastActive: Date.now() }))));
  await f.cleaner.releaseSession("side");
  f.cleaner.configure("balanced"); f.advance(100); await f.cleaner.collect();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 2);
  for (const id of ids) assert.ok(f.exists(id));
});

test("duplicate cleanup ownership cannot hide another record's active lease", async t => {
  const f = fixture(t), id = f.session();
  const token = await f.cleaner.acquire(id, true, 987654);
  const state = path.join(f.root, "state"), file = path.join(state, fs.readdirSync(state).find(n => n.startsWith("cleanup-sessions-"))!);
  const registry = JSON.parse(fs.readFileSync(file, "utf8"));
  registry.sessions.unshift({ ...registry.sessions[0], id: id.toUpperCase(), leases: [], replaced: true });
  fs.writeFileSync(file, JSON.stringify(registry));
  f.cleaner.configure("balanced"); f.advance(100);
  assert.equal(await f.cleaner.collect(), 0); assert.ok(f.exists(id));
  assert.ok(f.cleaner.status().failures > 0);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).sessions[1].leases[0].token, token);
});

test("recovery-path acquisition waits out short contention without blocking fail-fast callers", async t => {
  const f = fixture(t), id = f.session();
  await f.cleaner.acquire(id, true, 987654);
  const state = path.join(f.root, "state");
  const file = path.join(state, fs.readdirSync(state).find(n => n.startsWith("cleanup-sessions-"))!);
  let openSleep: () => void = () => {};
  const sleepGate = new Promise<void>(resolve => { openSleep = resolve; });
  let sleeps = 0;
  (f.cleaner as any).acquireRetry = { now: Date.now, sleep: () => { sleeps++; return sleepGate; } };
  fs.mkdirSync(file + ".lock");
  const other = randomUUID();
  const attempt = f.cleaner.acquire(other, false, 987654, 5000);
  await new Promise(resolve => setTimeout(resolve, 20));
  f.advance(1);
  await assert.rejects(f.cleaner.touch(id), (error: NodeJS.ErrnoException) => error.code === "ELOCKED",
    "touch keeps its raw fail-fast identity instead of queueing behind the retrying acquire");
  fs.rmdirSync(file + ".lock");
  openSleep();
  const token = await attempt;
  assert.ok(token, "the lease is acquired once contention clears");
  const registry = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(registry.sessions.find((v: any) => v.id === other).leases.length, 1);
  assert.ok(sleeps >= 1);
});

test("a lock budget expiring under sustained contention wraps the raw ELOCKED cause", async t => {
  const f = fixture(t), id = f.session();
  await f.cleaner.acquire(id, true, 987654);
  const state = path.join(f.root, "state");
  const file = path.join(state, fs.readdirSync(state).find(n => n.startsWith("cleanup-sessions-"))!);
  let lockClock = 1_000_000;
  let sleeps = 0;
  (f.cleaner as any).acquireRetry = { now: () => lockClock, sleep: async () => { sleeps++; lockClock += 10; } };
  fs.mkdirSync(file + ".lock");
  const failure = await f.cleaner.acquire(randomUUID(), false, 987654, 5000).then(() => undefined, error => error);
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, "Timed out acquiring the ACP cleanup lease");
  assert.equal((failure.cause as NodeJS.ErrnoException)?.code, "ELOCKED");
  assert.ok(sleeps <= 501, `bounded sleep count: ${sleeps}`);
  fs.rmdirSync(file + ".lock");
});

test("a non-lock registry failure bypasses the retry budget entirely", async t => {
  const f = fixture(t), id = f.session();
  await f.cleaner.acquire(id, true, 987654);
  const state = path.join(f.root, "state");
  const file = path.join(state, fs.readdirSync(state).find(n => n.startsWith("cleanup-sessions-"))!);
  const registry = JSON.parse(fs.readFileSync(file, "utf8"));
  registry.sessions.unshift({ ...registry.sessions[0], id: id.toUpperCase(), leases: [] });
  fs.writeFileSync(file, JSON.stringify(registry));
  let sleeps = 0;
  (f.cleaner as any).acquireRetry = { now: Date.now, sleep: async () => { sleeps++; } };
  await assert.rejects(f.cleaner.acquire(randomUUID(), false, 987654, 5000), /Duplicate ACP cleanup ownership/);
  assert.equal(sleeps, 0);
});

test("the default acquisition path keeps the raw ELOCKED identity", async t => {
  const f = fixture(t), id = f.session();
  await f.cleaner.acquire(id, true, 987654);
  const state = path.join(f.root, "state");
  const file = path.join(state, fs.readdirSync(state).find(n => n.startsWith("cleanup-sessions-"))!);
  let sleeps = 0;
  (f.cleaner as any).acquireRetry = { now: Date.now, sleep: async () => { sleeps++; } };
  fs.mkdirSync(file + ".lock");
  await assert.rejects(f.cleaner.acquire(randomUUID(), false, 987654), (error: NodeJS.ErrnoException) => error.code === "ELOCKED");
  assert.equal(sleeps, 0);
  fs.rmdirSync(file + ".lock");
});

test("the lock budget and the retention policy advance on separate clocks", async t => {
  const f = fixture(t), id = f.session();
  await f.cleaner.acquire(id, true, 987654);
  const state = path.join(f.root, "state");
  const file = path.join(state, fs.readdirSync(state).find(n => n.startsWith("cleanup-sessions-"))!);
  let lockClock = 5_000_000_000;
  let openSleep: () => void = () => {};
  const sleepGate = new Promise<void>(resolve => { openSleep = resolve; });
  (f.cleaner as any).acquireRetry = { now: () => lockClock, sleep: () => sleepGate };
  fs.mkdirSync(file + ".lock");
  const other = randomUUID();
  let settled = false;
  const attempt = f.cleaner.acquire(other, false, 987654, 5000);
  void attempt.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  f.advance(7);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "policy time must not spend the lock budget");
  lockClock += 6000;
  openSleep();
  await assert.rejects(attempt, /Timed out acquiring the ACP cleanup lease/);
  fs.rmdirSync(file + ".lock");
  const second = randomUUID();
  assert.ok(await f.cleaner.acquire(second, false, 987654, 5000));
  const registry = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(registry.sessions.find((v: any) => v.id === second).lastUsed, 1_000_000 + 7 * 86_400_000,
    "lastUsed comes from the policy clock even while the lock clock runs far ahead");
});

test("trackSource scans mappings once and stamps only mapped owned records", async t => {
  const f = fixture(t);
  const matching = f.session(), unrelated = f.session(), foreign = f.session();
  await f.cleaner.acquire(matching, true, 987654);
  await f.cleaner.acquire(unrelated, true, 987654);
  await f.cleaner.acquire(foreign, false, 987654);
  const root = path.join(f.root, "sessions"), file = path.join(root, "workspace", "chat.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: "session", id: "omp-chat" }) + "\n");
  const mappingFile = path.join(f.root, "state", "sessions.json");
  const mapping = (piSessionId: string, acpSessionId: string) => ({ piSessionId, acpSessionId, acpModelId: "flash", cwd: f.root, messageCount: 1, historyFingerprint: "test", lastActive: Date.now() });
  fs.writeFileSync(mappingFile, JSON.stringify([
    mapping("omp-chat", matching),
    mapping("omp-chat", matching),
    mapping("other-pi", unrelated),
    mapping("omp-chat", foreign),
  ]));
  const reads = { piSessionId: 0, acpSessionId: 0 };
  const store = (f.cleaner as any).sessionStore;
  const realList = store.list.bind(store);
  store.list = async () => (await realList()).map((m: any) => new Proxy(m, {
    get(target, prop) { if (prop === "piSessionId" || prop === "acpSessionId") reads[prop]++; return target[prop]; },
  }));
  await f.cleaner.trackSource("omp-chat", file);
  assert.equal(reads.piSessionId, 4, "one scan of the mapping list, not one per owned record");
  assert.equal(reads.acpSessionId, 3, "only mappings for the tracked OMP session expose their ACP id");
  const registryPath = path.join(f.root, "state", fs.readdirSync(path.join(f.root, "state")).find(n => n.startsWith("cleanup-sessions-"))!);
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const stat = fs.statSync(root);
  assert.deepEqual(registry.sessions.find((v: any) => v.id === matching).ompSource,
    { id: "omp-chat", file: path.resolve(file), root, device: stat.dev, inode: stat.ino });
  assert.equal(registry.sessions.find((v: any) => v.id === unrelated).ompSource, undefined, "a mapping for another OMP session never stamps");
  assert.equal(registry.sessions.find((v: any) => v.id === foreign).ompSource, undefined, "an unowned record is never stamped");
  fs.writeFileSync(mappingFile, JSON.stringify([]));
  const scanned = reads.piSessionId;
  await f.cleaner.trackSource("omp-chat", file);
  assert.equal(reads.piSessionId, scanned, "an empty mapping list performs no property scans");
});
