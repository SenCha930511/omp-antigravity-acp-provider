// Explicit live diagnostic: consumes quota and creates official ACP sessions.
// Run with Bun. Prints only test prompts/results and event counts, never auth.
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

if (!process.argv.includes("--live")) throw new Error("Pass --live explicitly: this diagnostic consumes quota and creates ACP sessions.");
// Default to this checkout's built adapter. To inspect the installed marketplace
// package, resolve its pinned version rather than assuming the npm latest tag.
let root = process.env.OMP_ACP_DIAGNOSTIC_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.includes("--installed")) {
  const wrapper = path.join(os.homedir(), ".omp/plugins/node_modules/omp-antigravity-acp-provider");
  const version = JSON.parse(fs.readFileSync(path.join(wrapper, "package.json"), "utf8")).version;
  root = path.join(wrapper, ".runtime", version, "node_modules/omp-antigravity-acp-provider");
}
const { TierConnection, Type } = await import(pathToFileURL(path.join(root, "extension/runtime.mjs")).href);
const { default: extension } = await import(pathToFileURL(path.join(root, "extension/index.ts")).href);
const reports: any[] = [];
let active: any;
let provider: any;
const hooks = new Map<string, Function>();
const wrapped = new WeakSet<object>();
const originalPrompt = TierConnection.prototype.prompt;
const synthetic = "[SYNTHETIC_THOUGHT_DIAGNOSTIC]";

TierConnection.prototype.prompt = async function(request: any, signal: AbortSignal) {
  const report = active;
  const wire = JSON.stringify(request.prompt);
  report.requests.push({
    routingPresent: wire.includes("Supplied OMP tools"),
    preferRulePresent: wire.includes("Call them directly for user tasks"),
    approvalRulePresent: wire.includes("obtain explicit approval"),
    piReadListed: wire.includes("OMP tool names: pi_read"),
    injectedSystemRetained: wire.includes("DIAGNOSTIC_SYSTEM_MARKER"),
    selectors: this.getSessionState(request.sessionId).configOptions?.map((option: any) => ({
      id: option.id, category: option.category, currentValue: option.currentValue,
    })),
  });
  if (!wrapped.has(this)) {
    wrapped.add(this);
    const handlers = this.handlers;
    this.setHandlers({ ...handlers,
      onUpdate: async (notification: any) => {
        const update = notification.update;
        report.rawEvents[update.sessionUpdate] = (report.rawEvents[update.sessionUpdate] ?? 0) + 1;
        if (update.sessionUpdate === "agent_thought_chunk") {
          report.rawThoughtTypes[update.content?.type ?? "missing"] = (report.rawThoughtTypes[update.content?.type ?? "missing"] ?? 0) + 1;
        }
        if (update.sessionUpdate === "tool_call") report.serverTools.push(update.title ?? update.toolCallId);
        await handlers.onUpdate?.(notification);
      },
      onPermission: async () => {
        report.deniedPermissions++;
        return { outcome: { outcome: "cancelled" } };
      },
    });
    // Known synthetic event tests the display pipeline separately from the
    // real server counters. It is never sent to Google as a prompt.
    if (report.label === "argon-high") await handlers.onUpdate?.({
      sessionId: request.sessionId,
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: synthetic } },
    });
  }
  return originalPrompt.call(this, request, signal);
};

await extension({
  on(name: string, handler: Function) { hooks.set(name, handler); },
  registerProvider(_name: string, registered: any) { provider = registered; },
  registerTool() {}, registerCommand() {},
});

async function run(label: string, id: string, effort: string, useTool: boolean) {
  const report = active = { label, id, effort, requests: [], rawEvents: {}, rawThoughtTypes: {},
    serverTools: [], ompToolCalls: [], deniedPermissions: 0, displayThoughtChars: 0, syntheticDisplayed: false, answer: "" };
  reports.push(report);
  const model = provider.models.find((item: any) => item.id === id);
  assert.ok(model, `Missing test model ${id}`);
  const sessionId = `observability-diagnostic-${label}-${Date.now()}`;
  const tools = useTool ? [{ name: "read", description: "Read the diagnostic fixture only. Pass path probe://fixture; this tool never accesses the filesystem.", parameters: Type.Object({ path: Type.String() }) }] : [];
  const system = "DIAGNOSTIC_SYSTEM_MARKER. This is a diagnostic. Do not access real files, run commands or browse. Use only the supplied diagnostic tool if requested.";
  const messages: any[] = [
    { role: "system", content: system, timestamp: 0 },
    { role: "user", content: useTool
      ? "Read probe://fixture using the supplied read tool. Return its content verbatim. Do not use native tools or search for real files."
      : "What is the remainder when 7^100 is divided by 13? Return the answer with a brief explanation. Then state which tool-priority instruction you were given. Do not use tools.", timestamp: Date.now() },
  ];
  try {
    for (let round = 0; round < 4; round++) {
      const stream = provider.streamSimple(model, { systemPrompt: system, messages, tools }, {
        sessionId, reasoning: effort, signal: AbortSignal.timeout(120_000),
      });
      let result: any;
      for await (const event of stream) {
        if (event.type === "error") throw new Error(event.error?.errorMessage ?? "Stream error");
        if (event.type === "thinking_delta") {
          report.displayThoughtChars += event.delta.length;
          if (event.delta.includes(synthetic)) report.syntheticDisplayed = true;
        }
        if (event.type === "done") result = structuredClone(event.message);
      }
      assert.ok(result, "No terminal assistant message");
      messages.push(result);
      const calls = result.content.filter((item: any) => item.type === "toolCall");
      if (!calls.length) {
        report.answer = result.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("");
        break;
      }
      for (const call of calls) {
        report.ompToolCalls.push({ name: call.name, arguments: call.arguments });
        const valid = call.name === "read" && call.arguments.path === "probe://fixture";
        messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name,
          content: [{ type: "text", text: valid ? "OMP_TOOL_PROBE_OK" : "Only diagnostic read(probe://fixture) is allowed" }],
          isError: !valid, timestamp: Date.now() });
      }
    }
    assert.ok(report.requests[0].routingPresent && report.requests[0].preferRulePresent && report.requests[0].approvalRulePresent);
    assert.ok(report.requests[0].injectedSystemRetained);
    if (useTool) {
      assert.ok(report.ompToolCalls.some((call: any) => call.name === "read"));
      assert.ok(report.answer.includes("OMP_TOOL_PROBE_OK"));
    }
    else assert.ok(report.answer.length > 0);
    if (label === "argon-high") assert.ok(report.syntheticDisplayed, "Synthetic ACP thought was not forwarded");
    console.log(JSON.stringify(report));
  } finally {
    await hooks.get("session_shutdown")?.({}, { sessionManager: { getSessionId: () => sessionId } });
  }
}

try {
  await run("argon-high", "gemini-4-argon", "high", false);
  await run("flash-high", "gemini-3.8-flash", "high", false);
  await run("argon-tool", "gemini-4-argon", "medium", true);
} finally {
  await hooks.get("session_shutdown")?.({}, {});
  TierConnection.prototype.prompt = originalPrompt;
}
