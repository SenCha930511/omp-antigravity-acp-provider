import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AntigravityRuntime } from "../extension/runtime.mjs";

const model = { id: "gemini-3.8-flash", name: "Flash", api: "antigravity-acp", provider: "antigravity-acp",
  contextWindow: 524288, maxTokens: 32000, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const user = (content: string) => ({ role: "user", content, timestamp: 1 });

test("built runtime rejects oversized plan refinement before prompting, then accepts compacted decisions and the new question", async () => {
  const requests: any[] = [];
  const modes = { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] };
  const models = { currentModelId: model.id, availableModels: [{ modelId: model.id, name: "Flash" }] };
  const runtime = new AntigravityRuntime((options: any) => {
    const exit = Promise.withResolvers<any>();
    const process = { alive: true, exited: exit.promise };
    let id: string;
    return { process,
      async initialize() { return { protocolVersion: 1, agentCapabilities: { promptCapabilities: { embeddedContext: true } } }; },
      async newSession() { id = randomUUID(); return { sessionId: id, modes, models }; },
      getSessionState() { return { modes, models }; },
      async prompt(request: any) {
        requests.push(structuredClone(request));
        options.handlers.onUpdate({ sessionId: id, update: { sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "REFINEMENT_ANSWER" } } });
        return { stopReason: "end_turn" };
      },
      async close() { process.alive = false; exit.resolve({ code: 0 }); },
    };
  }, "yolo");
  async function turn(messages: any[]) {
    const events: any[] = [];
    for await (const event of runtime.stream(model, { messages, tools: [] }, { sessionId: "plan-refine" }).stream) {
      events.push(structuredClone(event));
    }
    return events;
  }
  try {
    const oversized = await turn([user("ORIGINAL_PLAN_REQUEST"),
      { role: "assistant", provider: model.provider, model: model.id,
        content: [{ type: "text", text: "SOURCE_HISTORY ".repeat(50_000) }], timestamp: 2 },
      user("EXPLAIN_THE_APPROVED_ARCHITECTURE")]);
    assert.equal(requests.length, 0, "Never send a replay whose latest user question would be truncated");
    const error = oversized.find(event => event.type === "error")?.error;
    assert.match(error?.errorMessage, /Maximum context length exceeded:.*single-step/s);
    assert.ok(!error.errorMessage.includes("ORIGINAL_PLAN_REQUEST"), "Error messages must not disclose conversation content");
    const compacted = await turn([user("Compacted plan: Magpie; named tunnel; fixed upstream key. PLAN_COMPLETE."),
      user("EXPLAIN_THE_APPROVED_ARCHITECTURE")]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].prompt.at(-1).text, "EXPLAIN_THE_APPROVED_ARCHITECTURE");
    assert.match(JSON.stringify(requests[0].prompt), /Magpie; named tunnel; fixed upstream key/);
    assert.equal(compacted.find(event => event.type === "done")?.message.content[0].text, "REFINEMENT_ANSWER");
  } finally { await runtime.close(); }
});
