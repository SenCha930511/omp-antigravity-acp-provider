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
import { projectToolSchema } from "../extension/runtime/tools/schema.ts";

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
  OMP_ACP_TOOL_RELAY_MS: "0",
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

  const declarationLog = await trace();
  const hostTools = declarationLog.findLast(entry => entry.kind === "stream")?.tools ?? [];
  assert.deepEqual(hostTools.map((tool: { name: string }) => tool.name).sort(), ["context_notes", "new_context"],
    "the real OMP CLI must declare both requested host tools");
  const projectedTools = declarationLog.filter(entry => entry.kind === "mcp-tools").flatMap(entry => entry.tools)
    .filter(tool => tool.name === "pi_context_notes" || tool.name === "pi_new_context");
  assert.deepEqual(projectedTools.map(tool => tool.name).sort(), ["pi_context_notes", "pi_new_context"],
    "the real loopback MCP bridge must expose both projected tools");
  for (const hostTool of hostTools) {
    const projected = projectedTools.find(tool => tool.name === `pi_${hostTool.name}`);
    assert.ok(projected?.inputSchema, `${hostTool.name} must have an observed MCP input schema`);
    const raw = projectToolSchema(hostTool.parameters);
    assert.ok("schema" in raw, `${hostTool.name}'s raw host declaration must be projectable`);
    assert.ok(Array.isArray(raw.schema.required) && raw.schema.required.includes("i"),
      `${hostTool.name}'s raw host declaration must retain OMP's required intent metadata`);
    assert.ok(hostTool.executionSchema, `${hostTool.name}'s Bun witness must log the shared execution compatibility schema`);
    const expected = projectToolSchema(hostTool.executionSchema);
    assert.ok("schema" in expected, `${hostTool.name}'s execution compatibility schema must be projectable`);
    assert.deepEqual(projected.inputSchema, expected.schema,
      `${projected.name}'s declaration must use the execution compatibility schema, not the raw wire schema`);
    assert.equal(projected.inputSchema.properties?.i?.type, "string",
      `${projected.name} must preserve the supplied-intent property`);
    assert.ok(!projected.inputSchema.required?.includes("i"),
      `${projected.name} must accept calls without injected intent metadata`);
  }
  console.log(JSON.stringify({ ompTools: hostTools, projectedTools }));

  const notesArguments = {
    i: "Record context rollover witness",
    text: "Context rollover witness: preserve isolated session state.",
  };
  const noIntentText = "Context rollover witness saved without intent metadata.";
  await prompt("REQ_CONTEXT_NOTES_WITNESS");
  const witnessLog = await trace();
  const restoredCalls = witnessLog.filter(entry => entry.kind === "tool-call" && entry.toolCall?.name === "context_notes");
  assert.equal(restoredCalls.length, 3, "the witness must restore the supplied-intent, no-intent save and no-argument read calls");
  assert.deepEqual(restoredCalls.map(entry => entry.toolCall.arguments), [
    notesArguments,
    { text: noIntentText },
    {},
  ], "both supplied intent and missing-intent arguments must survive restoration without invented fields");
  const mcpCalls = witnessLog.filter(entry => entry.kind === "mcp-call");
  assert.deepEqual(mcpCalls.map(entry => ({ purpose: entry.purpose, name: entry.name, arguments: entry.arguments, activePrompts: entry.activePrompts })), [
    { purpose: "supplied-intent", name: "pi_context_notes", arguments: notesArguments, activePrompts: 1 },
    { purpose: "save-no-intent", name: "pi_context_notes", arguments: { text: noIntentText }, activePrompts: 1 },
    { purpose: "read-no-arguments", name: "pi_context_notes", arguments: {}, activePrompts: 1 },
  ], "all three MCP invocations must occur sequentially during the active ACP prompt");
  const mcpResults = witnessLog.filter(entry => entry.kind === "mcp-result");
  assert.deepEqual(mcpResults.map(entry => entry.isError), [false, false, false],
    "all three real host calls must complete without MCP errors");
  assert.deepEqual(mcpResults.find(entry => entry.purpose === "read-no-arguments")?.content, [noIntentText],
    "the no-argument read must return the exact notebook text saved by the no-intent call");

  const journalFile = witnessLog.find(entry => entry.kind === "event" && entry.event === "session_start" && typeof entry.file === "string")?.file;
  assert.ok(journalFile && journalFile.startsWith(`${temporary}${path.sep}`),
    "the synthetic notebook journal must live inside the isolated test root");
  const journalEntries = (await fs.readFile(journalFile, "utf8")).trim().split("\n")
    .filter(Boolean).map(line => JSON.parse(line));
  const journalNote = journalEntries.findLast(entry => entry.type === "custom" &&
    entry.customType === "experimental_context_notes" && entry.data?.text === noIntentText);
  assert.ok(journalNote, "the durable isolated journal must contain the no-intent notebook revision");
  assert.deepEqual(journalNote.data, { version: 1, text: noIntentText },
    "the durable journal entry must preserve exactly the saved version and text");
  const textBytes = Buffer.byteLength(journalNote.data.text, "utf8");
  assert.equal(textBytes, Buffer.byteLength(noIntentText, "utf8"),
    "the durable notebook bytes must match the no-intent save");
  console.log(JSON.stringify({
    restoredArguments: restoredCalls.map(entry => entry.toolCall.arguments),
    noIntentReadBack: mcpResults.find(entry => entry.purpose === "read-no-arguments")?.content,
    journal: { file: path.relative(temporary, journalFile), entryId: journalNote.id, version: journalNote.data.version, textBytes },
  }));
  console.log("Actual OMP compat schemas, supplied intent, no-intent save, no-argument read-back and durable journal: PASS");
} catch (error) {
  const log = await trace();
  console.error(JSON.stringify({
    prompts: prompts(log).map(entry => entry.prompt?.map((block: any) => block.text?.slice(0, 80))),
    doneUsage: log.filter(entry => entry.kind === "done-usage").map(entry => entry.usage),
    rollovers: rollovers(log),
    events: log.filter(entry => entry.kind === "event").map(entry => ({ event: entry.event, details: entry.details })),
    ompTools: log.findLast(entry => entry.kind === "stream")?.tools ?? [],
    projectedTools: log.filter(entry => entry.kind === "mcp-tools").flatMap(entry => entry.tools)
      .filter(tool => tool.name === "pi_context_notes" || tool.name === "pi_new_context"),
    mcpCalls: log.filter(entry => entry.kind === "mcp-call"),
    mcpResults: log.filter(entry => entry.kind === "mcp-result"),
    restoredToolCalls: log.filter(entry => entry.kind === "tool-call").map(entry => entry.toolCall),
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
