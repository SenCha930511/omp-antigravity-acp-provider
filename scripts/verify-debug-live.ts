// Explicit live UI-stream check, with isolated settings and synthetic tools.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerOmpAdapter } from "../extension/index.ts";
import { TierConnection, Type } from "../extension/runtime.mjs";
if (!process.argv.includes("--live")) throw new Error("Pass --live explicitly; consumes quota and creates an ACP session.");
const state = await fs.mkdtemp(path.join(os.tmpdir(), "omp-debug-live-"));
await fs.copyFile(path.join(os.homedir(), ".omp/agent/antigravity-acp-provider/models-cache.json"), path.join(state, "models-cache.json"));
const hooks = new Map<string, Function>();
let provider: any, command: any;
const originalPrompt = TierConnection.prototype.prompt;
const serverSessions = new Set<string>();
const thought = "[SYNTHETIC_DEBUG_THOUGHT]";
TierConnection.prototype.prompt = async function(request: any, signal: AbortSignal) {
  serverSessions.add(request.sessionId);
  await this.handlers.onUpdate?.({ sessionId: request.sessionId, update: {
    sessionUpdate: "agent_thought_chunk", content: { type: "text", text: thought },
  } });
  return originalPrompt.call(this, request, signal);
};
const sessionId = `debug-live-${Date.now()}`;
const tools = [{ name: "read", description: "Read synthetic probe://fixture only; no filesystem access.", parameters: Type.Object({ path: Type.String() }) }];
const messages: any[] = [];
const context = { ui: { notify() {} }, sessionManager: { getSessionId: () => sessionId } };
try {
  await registerOmpAdapter({
    on(name: string, fn: Function) { hooks.set(name, fn); },
    registerProvider(_name: string, value: any) { provider = value; },
    registerTool() {}, registerCommand(_name: string, value: any) { command = value; },
  }, state);
  await command.handler("native-tools disabled", context);
  const model = provider.models.find((m: any) => m.id === "gemini-4-argon");
  for (const mode of ["default-off", "on", "off"]) {
    if (mode !== "default-off") await command.handler(`debug ${mode}`, context);
    const marker = `DEBUG_TOOL_RESULT_${mode}`;
    messages.push({ role: "user", content: "Call the supplied read tool once for probe://fixture and return its result exactly. Always call it again for this new request. Do not use other tools or real files.", timestamp: Date.now() });
    let thinking = "", answer = "", toolCalls = 0;
    for (let round = 0; round < 4; round++) {
      let message: any;
      for await (const event of provider.streamSimple(model, { messages, tools, systemPrompt: "Diagnostic only; use the supplied synthetic read tool." }, { sessionId, reasoning: "medium", signal: AbortSignal.timeout(120_000) })) {
        if (event.type === "error") throw new Error(event.error?.errorMessage);
        if (event.type === "thinking_delta") thinking += event.delta;
        if (event.type === "done") message = structuredClone(event.message);
      }
      assert.ok(message);
      messages.push(message);
      const calls = message.content.filter((item: any) => item.type === "toolCall");
      if (!calls.length) {
        answer = message.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("");
        break;
      }
      for (const call of calls) {
        assert.equal(call.name, "read");
        assert.equal(call.arguments.path, "probe://fixture");
        toolCalls++;
        messages.push({ role: "toolResult", toolName: call.name, toolCallId: call.id, content: [{ type: "text", text: marker }], isError: false, timestamp: Date.now() });
      }
    }
    assert.ok(toolCalls > 0);
    assert.ok(answer.includes(marker));
    assert.ok(thinking.includes(thought), "Real thought event path was suppressed");
    const statusVisible = thinking.includes("[Antigravity tool");
    assert.equal(statusVisible, false, "Tool status must not pollute model reasoning");
    console.log(JSON.stringify({ mode, statusVisible, syntheticThoughtPreserved: true, ompToolCalls: toolCalls, answer, serverSessions: serverSessions.size }));
  }
  assert.equal(serverSessions.size, 1, "Debug toggles should not restart ACP");
  const policy = JSON.parse(await fs.readFile(path.join(state, "omp-tools.json"), "utf8"));
  assert.deepEqual(policy, { nativeTools: "disabled", debugToolUpdates: false });
} finally {
  await hooks.get("session_shutdown")?.({}, {});
  TierConnection.prototype.prompt = originalPrompt;
  await fs.rm(state, { recursive: true, force: true });
}
