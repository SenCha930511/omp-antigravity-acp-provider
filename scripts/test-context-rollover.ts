// Offline regression with the installed OMP CLI and a fake ACP transport.
// The fake server reports only cumulative billable usage (no usage_update),
// which used to make OMP treat cacheRead as context occupancy and roll over.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const omp = process.env.OMP_ACP_TEST_OMP_BIN ?? "omp";
const version = execFileSync(omp, ["--version"], { encoding: "utf8" }).trim();
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-context-rollover-")));
const state = path.join(temporary, "agent/antigravity-acp-provider");
const stateHome = path.join(temporary, "state");
await fs.mkdir(state, { recursive: true });
await fs.mkdir(path.join(stateHome, "omp"), { recursive: true });
await fs.writeFile(path.join(state, "context.json"), JSON.stringify({
  defaults: { contextWindow: 524288, maxTokens: 32000, usageMode: "off" },
  models: {},
}));
await fs.writeFile(path.join(state, "models-cache.json"), JSON.stringify({
  schemaVersion: 2,
  models: [{ modelId: "gemini-3.8-flash", name: "gemini-3.8-flash" }],
}));
const config = path.join(temporary, "config.json");
await fs.writeFile(config, JSON.stringify({
  compaction: {
    enabled: true,
    experimentalContextManagement: true,
    keepRecentTokens: 128,
    reserveTokens: 2048,
    thresholdTokens: 100000,
    thresholdPercent: -1,
    autoContinue: true,
    midTurnEnabled: false,
    asyncEnabled: false,
  },
  memory: { enabled: false },
}));
const args = [
  "--no-extensions", "-e", path.join(root, "test/fixtures/session-switch-extension.ts"),
  "--model", "antigravity-acp/gemini-3.8-flash", "--smol", "antigravity-acp/gemini-3.8-flash",
  "--thinking", "off", "--tools", "context_notes,new_context,read,grep",
  "--no-skills", "--no-rules", "--no-context-files", "--no-title", "--no-lsp",
  "--config", config, "--system-prompt", "OFFLINE_FIXTURE",
];
const env = {
  ...process.env,
  HOME: temporary,
  GEMINI_API_KEY: "offline-fixture",
  PI_CODING_AGENT_DIR: path.join(temporary, "agent"),
  GEMINI_HOME: path.join(temporary, "gemini"),
  XDG_STATE_HOME: stateHome,
  AGY_ACP_BIN: process.execPath,
  OMP_ACP_SESSION_TEST_STATE: state,
  OMP_ACP_SESSION_TEST_BILLING_USAGE: "1",
  OMP_ACP_IDLE_TIMEOUT_MS: "0",
  OMP_ACP_MAX_IDLE_RUNTIMES: "1",
  OMP_ACP_USAGE: "off",
};
const child = spawn(omp, ["--mode", "rpc", ...args], { cwd: temporary, stdio: ["pipe", "pipe", "pipe"], env });
const exited = once(child, "exit");
const responses = new Map<string, any>(), results = new Map<string, any>();
const frames: any[] = [], waiters = new Set<() => void>();
let stderr = "", serial = 0, stopped = false;
void exited.then(() => { stopped = true; for (const notify of waiters) notify(); });
child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
createInterface({ input: child.stdout }).on("line", line => {
  try {
    const frame = JSON.parse(line);
    frames.push(frame);
    if (frame.type === "response") responses.set(frame.id, frame);
    if (frame.type === "prompt_result") results.set(frame.id, frame);
    for (const notify of waiters) notify();
  } catch {}
});
async function until<T>(get: () => T | undefined, label: string): Promise<T> {
  const ready = get();
  if (ready !== undefined) return ready;
  const done = Promise.withResolvers<T>();
  const timer = setTimeout(() => done.reject(new Error(`Timed out: ${label}\n${stderr}`)), 20000);
  const check = () => {
    const value = get();
    if (value !== undefined) done.resolve(value);
    else if (stopped) done.reject(new Error(`OMP exited while waiting for ${label}\n${stderr}`));
  };
  waiters.add(check);
  try { check(); return await done.promise; }
  finally { clearTimeout(timer); waiters.delete(check); }
}
async function command(type: string, fields: object = {}) {
  const id = String(++serial);
  child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
  const response = await until(() => responses.get(id), type);
  assert.equal(response.success, true, JSON.stringify(response));
  return { id, data: response.data };
}
async function prompt(message: string) {
  const sent = await command("prompt", { message });
  const result = await until(() => results.get(sent.id), `prompt result: ${message.slice(0, 40)}`);
  assert.notEqual(result.status, "error", JSON.stringify(result));
  return result;
}
async function trace() {
  try {
    return (await fs.readFile(path.join(state, "trace.jsonl"), "utf8")).trim().split("\n")
      .filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function ompLogText(): Promise<string> {
  const texts: string[] = [];
  // The installed SDK writes diagnostics below HOME/.omp. HOME is this
  // fixture's temporary root, so this never reaches the user's global logs.
  const dir = path.join(temporary, ".omp", "logs");
  try {
    const files = (await fs.readdir(dir)).filter(file => file.endsWith(".log"));
    texts.push(...await Promise.all(files.map(file => fs.readFile(path.join(dir, file), "utf8"))));
  } catch {}
  assert.ok(texts.length > 0, "Expected current-test diagnostic logs inside the isolated state directory");
  return texts.join("\n");
}
const prompts = (entries: any[]) => entries.filter(entry => entry.kind === "prompt");
const rollovers = (entries: any[]) => entries.filter(entry =>
  entry.kind === "event" && entry.event === "session_compact" &&
  entry.details?.kind === "experimental-context-rollover");

try {
  await prompt(`REQ_ONE ${"A".repeat(20_000)}`);
  await prompt(`REQ_TWO ${"B".repeat(20_000)}`);
  await prompt(`REQ_THREE ${"C".repeat(20_000)}`);
  // A rollover schedules an automatic continuation after ~100 ms.
  await delay(1_000);
  const log = await trace();
  const usage = log.filter(entry => entry.kind === "done-usage").at(-1)?.usage;
  assert.ok(usage, "the adapter must deliver a done event");
  assert.equal(usage.cacheRead, 2_888_743, "cumulative billable cacheRead must remain intact");
  assert.equal(usage.contextTokensSource, "estimate");
  assert.ok(Number.isSafeInteger(usage.contextTokens) && usage.contextTokens > 0, "estimated context occupancy is required");
  assert.ok(usage.contextTokens < 100_000, `estimated occupancy must stay below the trigger: ${usage.contextTokens}`);
  const ompLog = await ompLogText();
  assert.doesNotMatch(ompLog, /experimental-context-rollover-retry/, "OMP must not schedule the rollover retry");
  assert.equal(rollovers(log).length, 0, "cumulative billing must not trigger an experimental context rollover");
  assert.equal(prompts(log).length, 3, "a rollover retry must not dispatch a fourth ACP prompt");
  console.log(JSON.stringify({
    omp: version,
    prompts: prompts(log).length,
    estimatedContextTokens: usage.contextTokens,
    billableCacheRead: usage.cacheRead,
    rollovers: rollovers(log).length,
    rolloverRetryLogged: false,
  }));
  console.log("Actual OMP + fake ACP: cumulative billing does not trigger experimental context rollover: PASS");
} catch (error) {
  const log = await trace();
  console.error(JSON.stringify({
    prompts: prompts(log).map(entry => entry.prompt?.map((block: any) => block.text?.slice(0, 80))),
    doneUsage: log.filter(entry => entry.kind === "done-usage").map(entry => entry.usage),
    rollovers: rollovers(log),
    events: log.filter(entry => entry.kind === "event").map(entry => ({ event: entry.event, details: entry.details })),
    recentFrames: frames.filter(frame => frame.type === "response" || frame.type === "prompt_result").slice(-5),
    retryLog: (await ompLogText()).split("\n").filter(line => line.includes("experimental-context-rollover-retry")),
    isolatedLogFiles: (await fs.readdir(temporary, { recursive: true })).filter(file => file.endsWith(".log")),
    stderr,
  }, null, 2));
  throw error;
} finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
  if (process.env.OMP_ACP_TEST_KEEP_ISOLATED_ROOT === "1") console.error(`Preserved isolated test root: ${temporary}`);
  else await fs.rm(temporary, { recursive: true, force: true });
}
