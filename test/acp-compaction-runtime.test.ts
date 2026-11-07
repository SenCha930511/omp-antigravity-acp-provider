import { test } from "node:test";
import assert from "node:assert/strict";
import { AntigravityRuntime } from "../extension/runtime.mjs";

const model = {
  id: "gemini-3.8-flash", name: "Flash", api: "antigravity-acp", provider: "antigravity-acp",
  contextWindow: 524_288, maxTokens: 32_000, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const modes = { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] };
const models = { currentModelId: model.id, availableModels: [{ modelId: model.id, name: "Flash" }] };
const user = (content: string) => ({ role: "user", content, timestamp: 1 });

function fixture() {
  const connections: any[] = [];
  const runtime = new AntigravityRuntime((options: any) => {
    const exit = Promise.withResolvers<any>();
    const c: any = {
      process: { alive: true, exited: exit.promise },
      handlers: options.handlers,
      async initialize() { return { protocolVersion: 1, agentCapabilities: {} }; },
      async newSession() { c.id = `session-${connections.length}`; return { sessionId: c.id, modes, models }; },
      getSessionState() { return { modes, models }; },
      async prompt() {
        await options.handlers.onUpdate({ sessionId: c.id,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ANSWER" } } });
        return { stopReason: "end_turn" };
      },
      async close() { if (!c.process.alive) return; c.process.alive = false; exit.resolve({ code: 0 }); },
    };
    connections.push(c);
    return c;
  }, "yolo");
  const run = async (messages: any[], id: string) => {
    const events: any[] = [];
    for await (const event of runtime.stream(model, { messages, tools: [] }, { sessionId: id }).stream) events.push(event);
    return events;
  };
  return { runtime, connections, run };
}

test("ACP compaction keeps a clean warm binding", async () => {
  const f = fixture();
  try {
    await f.run([user("A")], "clean");
    const binding: any = [...(f.runtime as any).resolvedBindings].find((item: any) => item.key === "sid:clean");
    f.connections[0].handlers.onUpdate({ sessionId: binding.session.sessionId,
      update: { sessionUpdate: "compaction_update", compactionId: "clean-1", status: "completed" } });
    assert.equal(binding.ompCompactionInvalidated, undefined);
    await f.run([user("A")], "clean");
    assert.equal(f.connections.length, 1, "a clean compaction must not retire the warm session");
  } finally { await f.runtime.close(); }
});

test("ACP compaction during pending work retires the binding before continuation", async () => {
  const f = fixture();
  try {
    await f.run([user("A")], "busy");
    const binding: any = [...(f.runtime as any).resolvedBindings].find((item: any) => item.key === "sid:busy");
    binding.pendingTools.set("tool-1", {
      invocation: { id: "tool-1", name: "read", arguments: {} },
      resolve() {},
    });
    f.connections[0].handlers.onUpdate({ sessionId: binding.session.sessionId,
      update: { sessionUpdate: "compaction_update", compactionId: "busy-1", status: "completed" } });
    assert.equal(binding.ompCompactionInvalidated, true);
    await f.run([user("A")], "busy");
    assert.equal(f.connections.length, 2, "the compacted pending binding must be replaced");
    assert.equal(f.connections[0].process.alive, false);
  } finally { await f.runtime.close(); }
});
