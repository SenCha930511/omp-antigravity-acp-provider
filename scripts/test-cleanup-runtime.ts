// Offline integration through the built runtime; no Google process or quota.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { AntigravityRuntime, AcpSessionStore, SessionCleanup, TierConnection } from "../extension/runtime.mjs";
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-cleanup-runtime-")));
const stateDir = path.join(root, "state"), acpDir = path.join(root, "acp");
fs.mkdirSync(path.join(acpDir, "conversations"), { recursive: true });
const cleanup = new SessionCleanup(stateDir, acpDir);
const connections: any[] = [];
let fail = false;
let stopReason = "end_turn";
const modes = { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] };
const models = { currentModelId: "gemini-3.8-flash", availableModels: [{ modelId: "gemini-3.8-flash", name: "Flash" }] };
function factory() {
  let exited!: (value: any) => void;
  const processState = { alive: true, pid: process.pid, exited: new Promise(resolve => { exited = resolve; }) };
  let lease: string | undefined, id: string | undefined;
  const connection = {
    process: processState,
    async initialize() { return { protocolVersion: 1, agentCapabilities: { promptCapabilities: { embeddedContext: true } } }; },
    async newSession() {
      id = randomUUID();
      fs.writeFileSync(path.join(acpDir, "conversations", `${id}.db`), "history");
      lease = await cleanup.acquire(id, true, process.pid);
      return { sessionId: id, modes, models };
    },
    getSessionState() { return { modes, models }; },
    async prompt() { if (fail) throw new Error("synthetic replacement failure"); return { stopReason }; },
    async retireForReplacement(key: string, session: string) { await cleanup.retire(key, session); },
    async confirmReplacement(key: string, session: string) { await cleanup.confirm(key, session); },
    async discardSession(session: string) { await cleanup.retire(`discovery:${session}`, session); await cleanup.confirm(`discovery:${session}`, "discovery-complete"); },
    async close() {
      if (!processState.alive) return;
      processState.alive = false;
      if (lease) await cleanup.release(lease);
      exited({ code: 0 });
    },
    get id() { return id; },
  };
  connections.push(connection);
  return connection;
}
const runtime = new AntigravityRuntime(factory, "yolo", new AcpSessionStore(path.join(stateDir, "sessions.json")));
const model = { id: "gemini-3.8-flash", name: "Flash", api: "antigravity-acp", provider: "antigravity-acp",
  contextWindow: 524288, maxTokens: 32000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
async function turn(text: string) {
  const writer = runtime.stream(model, { messages: [{ role: "user", content: text, timestamp: 1 }], tools: [] }, { sessionId: "fixture", signal: AbortSignal.timeout(10_000) });
  const events: any[] = [];
  for await (const event of writer.stream) events.push(event);
  return events;
}
try {
  assert.ok((await turn("original history")).some(e => e.type === "done"));
  const discovered = await runtime.discoverModels();
  assert.equal(discovered.length, 1);
  const discoveryId = connections.at(-1).id;
  assert.equal(fs.existsSync(path.join(acpDir, "conversations", `${discoveryId}.db`)), false, "Discovery session must be discarded and cleaned on close");
  const first = connections[0].id;
  fail = true;
  assert.ok((await turn("compacted summary")).some(e => e.type === "error"));
  assert.ok(fs.existsSync(path.join(acpDir, "conversations", `${first}.db`)), "Failed replacement must retain the old session");
  fail = false;
  stopReason = "max_tokens";
  assert.ok((await turn("compacted summary")).some(e => e.type === "done"));
  assert.ok(fs.existsSync(path.join(acpDir, "conversations", `${first}.db`)), "Incomplete replacement must retain the old session");
  stopReason = "end_turn";
  assert.ok((await turn("compacted summary")).some(e => e.type === "done"));
  assert.equal(fs.existsSync(path.join(acpDir, "conversations", `${first}.db`)), false, "Actual runtime must confirm successful reconstruction");
  const current = connections.at(-1).id;
  assert.ok(fs.existsSync(path.join(acpDir, "conversations", `${current}.db`)));
  await runtime.close();
  assert.ok(fs.existsSync(path.join(acpDir, "conversations", `${current}.db`)), "Normal shutdown must retain resumable state");
  console.log("Built runtime reconstruction, failed replacement, successful cleanup and normal shutdown: PASS");

  const parent: any = Object.getPrototypeOf(TierConnection.prototype);
  const originalResume = parent.resumeSession, originalClose = parent.close;
  const id = randomUUID(); let leased = false, released = false;
  const tier: any = Object.assign(Object.create(TierConnection.prototype), {
    process: { alive: true, pid: process.pid }, cleanupLeases: new Map(),
    cleanup: { acquire(got: string) { assert.equal(got, id); leased = true; return "lease"; },
      release() { assert.equal(tier.process.alive, false); released = true; } },
  });
  try {
    parent.resumeSession = async () => { assert.ok(leased, "Lease must exist before official resume dispatch"); return {}; };
    parent.close = async function() { this.process.alive = false; };
    await tier.resumeSession(id, root);
    tier.getSessionState = () => ({});
    let unloadedReleased = false;
    tier.cleanup.release = () => { unloadedReleased = true; };
    tier.cleanup.retire = () => {};
    await tier.retireForReplacement("sid:fixture", id);
    assert.ok(unloadedReleased, "Failed restore must release its pre-acquired lease before replacement runs");
    tier.cleanupLeases.set(id, "lease");
    tier.cleanup.release = () => { assert.equal(tier.process.alive, false); released = true; };
    await tier.close();
    assert.ok(released);
  } finally { parent.resumeSession = originalResume; parent.close = originalClose; }
  console.log("Actual TierConnection leases before replay and releases only after process exit: PASS");

  const active = randomUUID();
  fs.writeFileSync(path.join(acpDir, "conversations", `${active}.db`), "owned");
  const lease = await cleanup.acquire(active, true, process.pid);
  await cleanup.retire("peer", active); await cleanup.confirm("peer", randomUUID());
  const result = execFileSync(process.execPath, ["--input-type=module", "-e",
    'import {SessionCleanup} from ' + JSON.stringify(new URL("../extension/runtime.mjs", import.meta.url).href) + ';' +
    'const c=new SessionCleanup(process.argv[1],process.argv[2]);console.log(await c.collect());', stateDir, acpDir], { encoding: "utf8" });
  assert.equal(result.trim(), "0", "A separate real OS process must honor the parent's live lease");
  assert.ok(fs.existsSync(path.join(acpDir, "conversations", `${active}.db`)));
  await cleanup.release(lease);
  assert.equal(fs.existsSync(path.join(acpDir, "conversations", `${active}.db`)), false);
  console.log("Separate-process cleanup respects live shared leases: PASS");
} finally { await runtime.close(); await cleanup.stop(); fs.rmSync(root, { recursive: true, force: true }); }
