// Explicit offline integration with the installed OMP CLI. The fixture uses
// the real adapter and built runtime with a fake ACP transport: no inference.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const omp = process.env.OMP_ACP_TEST_OMP_BIN ?? "omp";
const version = execFileSync(omp, ["--version"], { encoding: "utf8" }).trim();
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-rpc-"));
const state = path.join(temporary, "agent/antigravity-acp-provider");
await fs.mkdir(state, { recursive: true });
await fs.writeFile(path.join(state, "context.json"), JSON.stringify({ defaults: { contextWindow: 524288, maxTokens: 32000, usageMode: "off" }, models: {} }));
await fs.writeFile(path.join(state, "models-cache.json"), JSON.stringify({ schemaVersion: 2,
  models: ["gemini-3.8-flash", "fixture-other"].map(modelId => ({ modelId, name: modelId })) }));
const config = path.join(temporary, "config.json");
await fs.writeFile(config, JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 128,
  reserveTokens: 2048, thresholdTokens: 25000, thresholdPercent: -1, methodOrder: ["soft"],
  asyncEnabled: false, autoContinue: false }, memory: { enabled: false } }));
const args = ["--no-extensions", "-e", path.join(root, "test/fixtures/session-switch-extension.ts"),
  "--model", "antigravity-acp/gemini-3.8-flash", "--smol", "antigravity-acp/gemini-3.8-flash", "--thinking", "off", "--no-tools", "--no-skills",
  "--no-rules", "--no-context-files", "--no-title", "--no-lsp", "--config", config, "--system-prompt", "OFFLINE_FIXTURE"];
const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(temporary, "agent"), GEMINI_HOME: path.join(temporary, "gemini"),
    AGY_ACP_BIN: process.platform === "win32" ? process.execPath : "/usr/bin/false", OMP_ACP_SESSION_TEST_STATE: state,
    OMP_ACP_IDLE_TIMEOUT_MS: "0", OMP_ACP_MAX_IDLE_RUNTIMES: "2", OMP_ACP_USAGE: "off" };
const child = spawn(omp, ["--mode", "rpc", ...args], {
  cwd: temporary, stdio: ["pipe", "pipe", "pipe"], env,
});
const exited = once(child, "exit");
const responses = new Map<string, any>(), results = new Map<string, any>();
const frames: any[] = [], waiters = new Set<() => void>();
let stderr = "", serial = 0;
let resumeFile: string | undefined;
let stopped = false;
void exited.then(() => { stopped = true; for (const notify of waiters) notify(); });
child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
createInterface({ input: child.stdout }).on("line", line => {
  try {
    const frame = JSON.parse(line); frames.push(frame);
    if (frame.type === "response") responses.set(frame.id, frame);
    if (frame.type === "prompt_result") results.set(frame.id, frame);
    for (const notify of waiters) notify();
  } catch {}
});
async function until<T>(get: () => T | undefined, label: string): Promise<T> {
  const ready = get(); if (ready !== undefined) return ready;
  const done = Promise.withResolvers<T>();
  const timer = setTimeout(() => done.reject(new Error(`Timed out: ${label}\n${stderr}`)), 20000);
  const check = () => { const value = get(); if (value !== undefined) done.resolve(value);
    else if (stopped) done.reject(new Error(`OMP exited while waiting for ${label}\n${stderr}`)); };
  waiters.add(check);
  try { check(); return await done.promise; }
  finally { clearTimeout(timer); waiters.delete(check); }
}
async function command(type: string, fields: object = {}) {
  const id = String(++serial);
  child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
  const response = await until(() => responses.get(id), type);
  assert.equal(response.success, true, JSON.stringify(response));
  return { id, data: response.data };
}
async function prompt(message: string) {
  const sent = await command("prompt", { message });
  const result = await until(() => results.get(sent.id), `prompt result: ${message}`);
  assert.notEqual(result.status, "error", JSON.stringify(result));
  return result;
}
async function trace() {
  try { return (await fs.readFile(path.join(state, "trace.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
const prompts = (entries: any[]) => entries.filter(e => e.kind === "prompt");
const current = (entry: any) => entry.prompt.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");

try {
  await command("set_auto_compaction", { enabled: false });
  await prompt("REQ_A_FIRST");
  const a = (await command("get_state")).data;
  let log = await trace();
  const acpA = prompts(log).at(-1).id;
  await command("new_session");
  await prompt("REQ_B_FIRST");
  const b = (await command("get_state")).data;
  assert.notEqual(a.sessionId, b.sessionId);
  const acpB = prompts(await trace()).at(-1).id;
  assert.notEqual(acpA, acpB);
  await command("switch_session", { sessionPath: a.sessionFile });
  await prompt("REQ_A_NEXT");
  log = await trace();
  const returnedA = prompts(log).at(-1);
  assert.notEqual(returnedA.id, acpB, "Returning to A must never use B's backend");
  assert.doesNotMatch(JSON.stringify(returnedA.prompt), /REQ_B_FIRST/);
  assert.doesNotMatch(current(returnedA), /REQ_A_FIRST/);
  if (returnedA.id === acpA) assert.doesNotMatch(JSON.stringify(returnedA.prompt), /REQ_A_FIRST/);
  assert.match(current(returnedA), /REQ_A_NEXT/);
  console.log("Actual OMP RPC: new B → resume A preserves ACP identity and sends only the new request: PASS");

  await command("fork");
  await prompt("REQ_FORK_NEXT");
  const forked = (await command("get_state")).data;
  assert.notEqual(forked.sessionId, a.sessionId);
  assert.notEqual(prompts(await trace()).at(-1).id, acpA);
  assert.match(current(prompts(await trace()).at(-1)), /REQ_FORK_NEXT/);
  console.log("Actual OMP RPC: fork uses a separate ACP conversation: PASS");

  await command("set_model", { provider: "antigravity-acp", modelId: "fixture-other" });
  await prompt("REQ_AFTER_MODEL_CHANGE");
  assert.equal(prompts(await trace()).at(-1).model, "fixture-other");
  console.log("Actual OMP RPC: model switch dispatches with the selected model: PASS");

  const entries = (await command("get_entries")).data.entries;
  const branchPoint = entries.find((entry: any) => entry.type === "message" && entry.message.role === "assistant");
  assert.ok(branchPoint);
  const beforeTree = prompts(await trace()).at(-1).id;
  await command("navigate_tree", { entryId: branchPoint.id, summarize: false });
  await prompt("REQ_AFTER_TREE_REWIND");
  const afterTree = prompts(await trace()).at(-1);
  assert.notEqual(afterTree.id, beforeTree);
  assert.doesNotMatch(JSON.stringify(afterTree.prompt), /REQ_A_NEXT|REQ_FORK_NEXT|REQ_AFTER_MODEL_CHANGE/);
  assert.match(current(afterTree), /REQ_AFTER_TREE_REWIND/);
  console.log("Actual OMP RPC: /tree rewind rebuilds without discarded branch messages: PASS");

  const beforeFresh = (await command("get_state")).data;
  const previousAcp = afterTree.id;
  await prompt("/fresh");
  const fresh = (await command("get_state")).data;
  assert.equal(fresh.sessionFile, beforeFresh.sessionFile);
  assert.notEqual(fresh.sessionId, beforeFresh.sessionId);
  assert.ok((await trace()).some(entry => entry.kind === "close" && entry.id === previousAcp),
    "OMP /fresh must close the adapter's previous provider session too");
  await prompt("REQ_AFTER_FRESH");
  assert.notEqual(prompts(await trace()).at(-1).id, previousAcp);
  assert.match(current(prompts(await trace()).at(-1)), /REQ_AFTER_FRESH/);
  console.log("Actual OMP RPC: /fresh rotates provider identity and closes old runtime: PASS");

  const corrupted = path.join(temporary, "corrupt.jsonl");
  await fs.writeFile(corrupted, "not a session\n");
  const stable = prompts(await trace()).at(-1).id;
  await assert.rejects(command("switch_session", { sessionPath: corrupted }));
  await prompt("REQ_AFTER_REJECTED_SWITCH");
  const afterRejected = prompts(await trace()).at(-1);
  assert.equal(afterRejected.id, stable);
  assert.doesNotMatch(JSON.stringify(afterRejected.prompt), /REQ_AFTER_FRESH/);
  console.log("Actual OMP RPC: failed session switch keeps the active conversation and sends only the next request: PASS");

  const branchEntries = (await command("get_entries")).data.entries;
  const oldUser = branchEntries.find((entry: any) => entry.type === "message" && entry.message.role === "user");
  await command("branch", { entryId: oldUser.id });
  await prompt("REQ_BRANCH_NEW");
  const branched = prompts(await trace()).at(-1);
  assert.notEqual(branched.id, stable);
  assert.doesNotMatch(JSON.stringify(branched.prompt), /REQ_AFTER_REJECTED_SWITCH|REQ_AFTER_FRESH|REQ_A_FIRST/);
  assert.match(current(branched), /REQ_BRANCH_NEW/);
  console.log("Actual OMP RPC: branching to edit an earlier user request creates isolated context: PASS");

  const held = await command("prompt", { message: "REQ_HOLD_CANCEL" });
  await command("abort");
  const cancelled = await until(() => results.get(held.id), "cancelled prompt");
  assert.equal(cancelled.status, "aborted");
  const cancelledSession = (await command("get_state")).data;
  await command("new_session");
  await prompt("REQ_AFTER_CANCEL_OTHER_SESSION");
  const unrelated = prompts(await trace()).at(-1).id;
  await command("switch_session", { sessionPath: cancelledSession.sessionFile });
  await prompt("REQ_AFTER_CANCEL_RESUME");
  const afterCancel = prompts(await trace()).at(-1);
  assert.notEqual(afterCancel.id, unrelated);
  assert.doesNotMatch(current(afterCancel), /REQ_HOLD_CANCEL|REQ_AFTER_CANCEL_OTHER_SESSION/);
  assert.equal((current(afterCancel).match(/REQ_AFTER_CANCEL_RESUME/g) ?? []).length, 1);
  console.log("Actual OMP RPC: cancel → new session → resume cannot leak the other session or repeat the interrupted request: PASS");

  await prompt("REQ_LONG_FOR_COMPACTION " + "synthetic context ".repeat(350));
  const beforeCompact = prompts(await trace()).length;
  await command("compact");
  assert.ok(prompts(await trace()).length > beforeCompact, "OMP must call the actual adapter for summarization");
  await prompt("REQ_AFTER_COMPACTION");
  const afterCompact = prompts(await trace()).at(-1);
  assert.equal((current(afterCompact).match(/REQ_AFTER_COMPACTION/g) ?? []).length, 1);
  assert.doesNotMatch(current(afterCompact), /REQ_LONG_FOR_COMPACTION|REQ_HOLD_CANCEL/);
  assert.ok((await trace()).some(entry => entry.kind === "event" && entry.event === "session_compact"));
  console.log("Actual OMP RPC: manual compaction invokes the adapter, rebuilds context and preserves the next request exactly once: PASS");

  const compactions = (await trace()).filter(entry => entry.kind === "event" && entry.event === "session_compact").length;
  await command("set_auto_compaction", { enabled: true });
  await prompt("REQ_AUTO_COMPACT");
  assert.ok((await trace()).filter(entry => entry.kind === "event" && entry.event === "session_compact").length > compactions);
  await command("set_auto_compaction", { enabled: false });
  await prompt("REQ_AFTER_AUTO_COMPACTION");
  const afterAuto = prompts(await trace()).at(-1);
  assert.equal((current(afterAuto).match(/REQ_AFTER_AUTO_COMPACTION/g) ?? []).length, 1);
  assert.doesNotMatch(current(afterAuto), /REQ_LONG_FOR_COMPACTION|REQ_HOLD_CANCEL|REQ_AUTO_COMPACT/);
  console.log("Actual OMP RPC: automatic compaction with synthetic occupancy keeps the next user request isolated: PASS");

  await prompt("/antigravity-acp permissions default");
  await prompt("REQ_AFTER_PERMISSION_CHANGE");
  const afterPermission = prompts(await trace()).at(-1);
  assert.equal(afterPermission.mode, "default");
  assert.equal((current(afterPermission).match(/REQ_AFTER_PERMISSION_CHANGE/g) ?? []).length, 1);
  console.log("Actual OMP command: permission-mode change applies to the next dispatch exactly once: PASS");

  const mainBeforeSide = prompts(await trace()).at(-1).id;
  await prompt("/fixture-one-shot");
  const sideLog = await trace();
  const sideStream = sideLog.filter(e => e.kind === "stream").at(-1);
  const sideAcp = prompts(sideLog).at(-1).id;
  assert.ok(sideStream.sessionId.includes(":side:"));
  assert.notEqual(sideAcp, mainBeforeSide);
  assert.ok(sideLog.some(e => e.kind === "one-shot-complete"));
  let saved: any[] = [];
  for (let i = 0; i < 200; i++) {
    saved = JSON.parse(await fs.readFile(path.join(state, "sessions.json"), "utf8"));
    if (!saved.some(record => record.piSessionId === sideStream.sessionId)) break;
    await delay(10);
  }
  assert.ok(!saved.some(record => record.piSessionId === sideStream.sessionId), "Final one-shot release must remove its saved mapping");
  assert.ok(saved.some(record => record.acpSessionId === mainBeforeSide), "One-shot cleanup must preserve the main conversation");
  await fs.access(path.join(temporary, "gemini/antigravity-acp/conversations", sideAcp + ".db"));
  await prompt("REQ_AFTER_ONE_SHOT_RELEASE");
  const afterSide = prompts(await trace()).at(-1);
  assert.equal(afterSide.id, mainBeforeSide);
  assert.doesNotMatch(JSON.stringify(afterSide.prompt), /REQ_ONE_SHOT_RELEASE/);
  assert.equal((current(afterSide).match(/REQ_AFTER_ONE_SHOT_RELEASE/g) ?? []).length, 1);
  console.log("Actual OMP ephemeral turn: final release unmaps only the side request, retains its recovery copy and preserves the main session: PASS");

  log = await trace();
  const firstInstructions = prompts(log)[0].prompt.find((block: any) => block.resource?.uri.endsWith(":instructions"))?.resource.text;
  assert.match(firstInstructions, /FIXTURE_SYSTEM_ONE\n\nFIXTURE_SYSTEM_TWO/);
  console.log("Actual OMP array system instructions preserve paragraph boundaries: PASS");
  resumeFile = (await command("get_state")).data.sessionFile;
  console.log(JSON.stringify({ omp: version, promptCalls: prompts(log).length,
    sessionEvents: log.filter(e => e.kind === "event").map(e => ({ event: e.event, reason: e.reason })), inferenceCalls: 0 }));
} catch (error) {
  console.error(JSON.stringify({ trace: (await trace()).map(entry => entry.kind === "stream"
    ? { ...entry, messages: entry.messages.map((message: any) => ({ role: message.role, content: JSON.stringify(message.content).slice(0, 160) })) }
    : entry.kind === "prompt"
    ? { ...entry, prompt: entry.prompt.map((block: any) => block.resource
      ? { ...block, resource: { ...block.resource, text: block.resource.text.slice(0, 220) } } : block) } : entry),
    recentFrames: frames.filter(f => f.type === "response" || f.type === "prompt_result").slice(-5), stderr }, null, 2));
  throw error;
} finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited; clearTimeout(timer);
  try {
    if (resumeFile) {
      const beforeRestart = prompts(await trace()).length;
      const run = promisify(execFile)(omp, ["--mode", "json", ...args, "--resume", resumeFile, "-p", "REQ_AFTER_PROCESS_RESTART"],
        { cwd: temporary, env, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
      run.child.stdin?.end();
      const result = await run;
      const output = result.stdout.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      assert.ok(!output.some(frame => frame.type === "error"), JSON.stringify(output));
      const restarted = prompts(await trace()).slice(beforeRestart);
      assert.equal(restarted.length, 1, "Reopening the OMP process must dispatch the follow-up exactly once");
      assert.match(current(restarted[0]), /REQ_AFTER_PROCESS_RESTART/);
      assert.doesNotMatch(current(restarted[0]), /REQ_AFTER_CANCEL_RESUME|REQ_LONG_FOR_COMPACTION|REQ_AUTO_COMPACT/);
      console.log("Actual OMP process restart and --resume: one follow-up dispatch, no historical request re-execution: PASS");
    }
    const open = new Map<string, number>();
    for (const entry of await trace()) {
      if (!entry.id) continue;
      if (entry.kind === "new" || entry.kind === "resume") open.set(entry.id, (open.get(entry.id) ?? 0) + 1);
      if (entry.kind === "close") open.set(entry.id, (open.get(entry.id) ?? 0) - 1);
    }
    assert.ok([...open.values()].every(count => count === 0), "OMP shutdown must close every routing identity, including /fresh identities");
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
