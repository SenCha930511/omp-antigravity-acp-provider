// Explicit live probe for the agy limits listed in the 2026-11-08 plan.
// Default mode only reads the local SQLite conversation store. Live modes
// consume account quota and create ACP sessions; pass the flag explicitly.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.OMP_ACP_DIAGNOSTIC_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const live = process.argv.includes("--live");
const toolLive = process.argv.includes("--tool-live");
const slowTool = process.argv.includes("--slow-tool");
const schema = process.argv.includes("--schema");
const maxTokens = process.argv.includes("--max-tokens");
if (maxTokens) process.env.OMP_ACP_MAX_CONTINUATIONS = "0";
const clientInfo = process.argv.includes("--client-info");
const { AntigravityRuntime, AcpSessionStore, TierConnection, Type, resolveAntigravityAcpDirectory } = await import(pathToFileURL(path.join(root, "extension/runtime.mjs")).href);
const { conversationDbPath, peekMaxModelStepIdx, readModelStepsAfter } = await import(pathToFileURL(path.join(root, "extension/usage-db.ts")).href);
const { projectCatalog, selectRuntimeModel } = await import(pathToFileURL(path.join(root, "extension/model-catalog.ts")).href);

const report: Record<string, unknown> = {
  acpDirectory: resolveAntigravityAcpDirectory(),
  sqlite: {},
  live: undefined,
  slowTool: undefined,
  schema: undefined,
  clientInfo: undefined,
};

async function inspectSqlite(): Promise<void> {
  const directory = path.join(resolveAntigravityAcpDirectory(), "conversations");
  const entries = await fs.readdir(directory).catch(() => [] as string[]);
  const databases = await Promise.all(entries.filter(name => name.endsWith(".db")).map(async name => {
    const file = path.join(directory, name);
    return { name, file, modified: (await fs.stat(file)).mtimeMs };
  }));
  databases.sort((left, right) => right.modified - left.modified);
  const sqlite: Record<string, unknown> = {};
  for (const database of databases.slice(0, 3)) {
    const maxIdx = peekMaxModelStepIdx(database.file);
    sqlite[database.name] = {
      maxModelStepIdx: maxIdx,
      batch: maxIdx >= 0 ? readModelStepsAfter(database.file, -1) : undefined,
    };
  }
  report.sqlite = sqlite;
}

async function loadModel(): Promise<any> {
  const cachePath = path.join(os.homedir(), ".omp/agent/antigravity-acp-provider/models-cache.json");
  const cache = JSON.parse(await fs.readFile(cachePath, "utf8"));
  const models = projectCatalog(cache.models);
  if (!models.length) throw new Error("No cached Antigravity models; run /antigravity-acp refresh first.");
  return selectRuntimeModel(models.find((model: any) => model.id === "gemini-3.8-flash") ?? models[0], "low");
}

function createRuntime(directory: string, onSession: (id: string) => void): any {
  return new AntigravityRuntime((options: any) => {
    const connection = new TierConnection({ ...options });
    const newSession = connection.newSession.bind(connection);
    connection.newSession = async (...args: any[]) => {
      const session = await newSession(...args);
      onSession(session.sessionId);
      return session;
    };
    return connection;
  }, "yolo", new AcpSessionStore(path.join(directory, "sessions.json")));
}

async function runTurn(runtime: any, model: any, messages: any[], tools: any[], sessionId: string, signal: AbortSignal): Promise<any> {
  const writer = runtime.stream(model, {
    messages,
    tools,
    systemPrompt: "Diagnostic only. Use only the supplied synthetic tools. Do not read files, run commands, or browse.",
  }, { sessionId, reasoning: "low", signal });
  let message: any;
  for await (const event of writer.stream) {
    if (event.type === "error") throw new Error(event.error?.errorMessage ?? "Live stream failed");
    if (event.type === "done") message = structuredClone(event.message);
  }
  if (!message) throw new Error("Live stream ended without a message");
  return message;
}

async function waitForUsage(sessionId: string): Promise<unknown> {
  const file = conversationDbPath(resolveAntigravityAcpDirectory(), sessionId);
  if (!file) return { file: undefined, batch: undefined };
  for (let attempt = 0; attempt < 20; attempt++) {
    const maxIdx = peekMaxModelStepIdx(file);
    if (maxIdx >= 0) return { file, batch: readModelStepsAfter(file, -1) };
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return { file, batch: undefined };
}

async function probeLive(): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agy-probe-"));
  const model = await loadModel();
  const sessionId = `agy-probe-${Date.now()}`;
  let acpSessionId: string | undefined;
  const runtime = createRuntime(directory, id => { acpSessionId = id; });
  try {
    const messages: any[] = [{ role: "user", content: "Reply exactly PROBE_OK. Do not call tools.", timestamp: Date.now() }];
    const message = await runTurn(runtime, model, messages, [], sessionId, AbortSignal.timeout(120_000));
    const usage = await waitForUsage(acpSessionId ?? "");
    report.live = {
      acpSessionId,
      text: message.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join(""),
      ompUsage: message.usage,
      sqliteUsage: usage,
    };
  } finally {
    await runtime.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function probeToolLive(): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agy-tool-"));
  const model = await loadModel();
  const sessionId = `agy-tool-${Date.now()}`;
  let acpSessionId: string | undefined;
  const tools = [{ name: "ping", description: "Return PONG.", parameters: Type.Object({}) }];
  const runtime = createRuntime(directory, id => { acpSessionId = id; });
  try {
    const messages: any[] = [{ role: "user", content: "Call ping once, then reply TOOL_PROBE_OK.", timestamp: Date.now() }];
    const first = await runTurn(runtime, model, messages, tools, sessionId, AbortSignal.timeout(120_000));
    messages.push(first);
    const calls = first.content.filter((item: any) => item.type === "toolCall");
    if (!calls.length) {
      report.toolLive = { acpSessionId, calls: [], text: first.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("") };
      return;
    }
    for (const call of calls) {
      messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "PONG" }], isError: false, timestamp: Date.now() });
    }
    const second = await runTurn(runtime, model, messages, tools, sessionId, AbortSignal.timeout(120_000));
    report.toolLive = {
      acpSessionId,
      calls: calls.map((call: any) => call.name),
      firstUsage: first.usage,
      secondUsage: second.usage,
      text: second.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join(""),
      sqliteUsage: await waitForUsage(acpSessionId ?? ""),
    };
  } finally {
    await runtime.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function probeSlowTool(): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agy-slow-"));
  const model = await loadModel();
  const sessionId = `agy-slow-${Date.now()}`;
  const sleepMs = Number(process.env.OMP_ACP_PROBE_SLEEP_MS ?? 190_000);
  const tools = [{ name: "sleep", description: "Wait for the requested number of milliseconds.", parameters: Type.Object({ ms: Type.Number() }) }];
  const runtime = createRuntime(directory, () => {});
  const started = Date.now();
  try {
    const messages: any[] = [{ role: "user", content: `Call sleep with ms=${sleepMs}, then reply SLOW_TOOL_OK.`, timestamp: Date.now() }];
    const message = await runTurn(runtime, model, messages, tools, sessionId, AbortSignal.timeout(sleepMs + 120_000));
    messages.push(message);
    const calls = message.content.filter((item: any) => item.type === "toolCall");
    if (!calls.length) {
      report.slowTool = { sleepMs, elapsedMs: Date.now() - started, calls: [], text: message.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("") };
      return;
    }
    await new Promise(resolve => setTimeout(resolve, sleepMs));
    for (const call of calls) {
      messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "slept" }], isError: false, timestamp: Date.now() });
    }
    const final = await runTurn(runtime, model, messages, tools, sessionId, AbortSignal.timeout(120_000));
    report.slowTool = { sleepMs, elapsedMs: Date.now() - started, calls: calls.map((call: any) => call.name), text: final.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("") };
  } catch (error) {
    report.slowTool = { sleepMs, elapsedMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await runtime.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function probeSchema(): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agy-schema-"));
  const model = await loadModel();
  const sessionId = `agy-schema-${Date.now()}`;
  const properties: Record<string, unknown> = {};
  for (let index = 0; index < 80; index++) properties[`field_${index}`] = Type.String({ description: "Synthetic field used to measure eager schema loading." });
  const tools = [{ name: "big_schema", description: "Synthetic tool with a deliberately large schema.", parameters: Type.Object(properties) }];
  const runtime = createRuntime(directory, () => {});
  try {
    const messages: any[] = [{ role: "user", content: "Call big_schema once, then reply BIG_SCHEMA_OK.", timestamp: Date.now() }];
    const message = await runTurn(runtime, model, messages, tools, sessionId, AbortSignal.timeout(120_000));
    report.schema = {
      bytes: JSON.stringify(tools[0]).length,
      calls: message.content.filter((item: any) => item.type === "toolCall").map((call: any) => call.name),
      text: message.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join(""),
    };
  } catch (error) {
    report.schema = { bytes: JSON.stringify(tools[0]).length, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await runtime.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function probeMaxTokens(): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agy-maxtokens-"));
  const model = await loadModel();
  const sessionId = `agy-maxtokens-${Date.now()}`;
  const runtime = createRuntime(directory, () => {});
  try {
    const messages: any[] = [{ role: "user", content: "Write the longest possible detailed essay about the history of computing. Do not stop early and do not summarize.", timestamp: Date.now() }];
    const message = await runTurn(runtime, model, messages, [], sessionId, AbortSignal.timeout(600_000));
    report.maxTokens = {
      stopReason: message.stopReason,
      rawStopReason: message.rawStopReason,
      bytes: JSON.stringify(message.content).length,
      usage: message.usage,
    };
  } catch (error) {
    report.maxTokens = { error: error instanceof Error ? error.message : String(error) };
  } finally {
    await runtime.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

await inspectSqlite();
if (maxTokens) await probeMaxTokens();
if (live) await probeLive();
if (toolLive) await probeToolLive();
if (slowTool) await probeSlowTool();
if (schema) await probeSchema();
if (clientInfo) {
  report.clientInfo = "Not probed: changing clientInfo.name is identity spoofing and remains a product decision.";
}
console.log(JSON.stringify(report, null, 2));
