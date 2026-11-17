// Explicit, isolated live probe of Google ACP session metadata. No production
// configuration is changed. The only OMP tool reads a synthetic in-memory value.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
if (!process.argv.includes("--live")) throw new Error("Pass --live explicitly; this probe consumes quota and creates an ACP session.");

const wrapper = path.join(os.homedir(), ".omp/plugins/node_modules/omp-antigravity-acp-provider");
const version = JSON.parse(fs.readFileSync(path.join(wrapper, "package.json"), "utf8")).version;
const root = path.join(wrapper, ".runtime", version, "node_modules/omp-antigravity-acp-provider");
const { TierConnection, AntigravityRuntime, Type } = await import(pathToFileURL(path.join(root, "extension/runtime.mjs")).href);
const { projectCatalog, selectRuntimeModel } = await import(pathToFileURL(path.join(root, "extension/model-catalog.ts")).href);
const cache = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".omp/agent/antigravity-acp-provider/models-cache.json"), "utf8"));
const model = selectRuntimeModel(projectCatalog(cache.models).find((m: any) => m.id === "gemini-4-argon"), "medium");
const report: any = { installedVersion: version, metadataSent: false, rawEvents: {}, toolTitles: [], ompCalls: [], answer: "" };
const marker = "SYSTEM_APPEND_ONLY_6D49";
const runtime = new AntigravityRuntime((options: any) => {
  const handlers = options.handlers;
  const connection = new TierConnection({ ...options, ompDebugToolUpdates: true, handlers: { ...handlers,
    onUpdate: async (notification: any) => {
      const update = notification.update;
      report.rawEvents[update.sessionUpdate] = (report.rawEvents[update.sessionUpdate] ?? 0) + 1;
      if (update.sessionUpdate === "tool_call") report.toolTitles.push(update.title);
      await handlers.onUpdate?.(notification);
    },
    onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  } });
  const rpc = connection.connection;
  const createSession = rpc.newSession.bind(rpc);
  rpc.newSession = async (request: any) => {
    const response = await createSession({ ...request, _meta: { antigravity: {
      systemPrompt: { append: `For this diagnostic only: use the supplied omp_read tool to read probe://fixture. Do not access real files or use any other tool. After the tool result, append this exact confirmation: ${marker}` },
      eagerMcpServers: ["pi-bridge"],
      enabledTools: [],
    } } });
    report.metadataSent = true;
    return response;
  };
  return connection;
}, "yolo");

const messages: any[] = [{ role: "user", content: "Read probe://fixture and return its content. Follow your session instructions.", timestamp: Date.now() }];
const tools = [{ name: "read", description: "Read the in-memory diagnostic fixture. Only path probe://fixture is valid; no filesystem access.", parameters: Type.Object({ path: Type.String() }) }];
const probeSessionId = `session-meta-probe-${Date.now()}`;
try {
  for (let round = 0; round < 4; round++) {
    const writer = runtime.stream(model, { messages, tools }, { reasoning: "medium", sessionId: probeSessionId, signal: AbortSignal.timeout(120_000) });
    let message: any;
    for await (const event of writer.stream) {
      if (event.type === "error") throw new Error(event.error?.errorMessage ?? "Probe stream failed");
      if (event.type === "done") message = structuredClone(event.message);
    }
    assert.ok(message, "No terminal message");
    messages.push(message);
    const calls = message.content.filter((item: any) => item.type === "toolCall");
    if (!calls.length) {
      report.answer = message.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("");
      break;
    }
    for (const call of calls) {
      report.ompCalls.push({ name: call.name, arguments: call.arguments });
      const valid = call.name === "read" && call.arguments.path === "probe://fixture";
      messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: valid ? "METADATA_MCP_PROBE_OK" : "Invalid diagnostic request" }], isError: !valid, timestamp: Date.now() });
    }
  }
  assert.ok(report.metadataSent);
  assert.ok(report.ompCalls.some((call: any) => call.name === "read"));
  assert.ok(report.answer.includes("METADATA_MCP_PROBE_OK"));
  assert.ok(report.answer.includes(marker), "System-only instruction did not reach the model");
  console.log(JSON.stringify(report));
} finally {
  await runtime.close();
}
