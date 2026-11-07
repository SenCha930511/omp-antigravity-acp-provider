import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AntigravityRuntime, Type } from "../extension/runtime.mjs";

const model = { id: "gemini-3.8-flash", name: "Flash", api: "antigravity-acp", provider: "antigravity-acp",
  contextWindow: 524288, maxTokens: 32000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const modes = { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] };
const models = { currentModelId: model.id, availableModels: [{ modelId: model.id, name: "Flash" }] };
const tools = {
  read: { name: "read", description: "Read a file.", parameters: Type.Object({ path: Type.String() }) },
  bash: { name: "bash", description: "Run a command.", parameters: Type.Object({ command: Type.String() }) },
};
let sessions = 0;
let prompts = 0;
const runtime: any = new AntigravityRuntime(() => {
  const exit = Promise.withResolvers();
  const process = { alive: true, exited: exit.promise };
  return {
    process,
    async initialize() { return { protocolVersion: 1, agentCapabilities: { promptCapabilities: { embeddedContext: true }, mcpCapabilities: { http: true } } }; },
    async newSession() { sessions++; return { sessionId: randomUUID(), modes, models }; },
    getSessionState() { return { modes, models }; },
    async prompt() { prompts++; return { stopReason: "end_turn" }; },
    async close() { process.alive = false; exit.resolve({ code: 0 }); },
  };
}, "yolo", { get: () => undefined, save: () => {}, remove: () => {} });

const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });
async function turn(messages: any[], selected: any[]): Promise<any> {
  let message: any;
  for await (const event of runtime.stream(model, { messages, tools: selected }, { sessionId: "tools" }).stream) {
    if (event.type === "done") message = event.message;
  }
  return message;
}

try {
  const first = await turn([user("TOOL_SET")], [tools.read]);
  const second = await turn([user("TOOL_SET"), first, user("ADD_TOOL")], [tools.read, tools.bash]);
  await turn([user("TOOL_SET"), first, user("ADD_TOOL"), second, user("REMOVE_TOOL")], [tools.bash]);
  assert.equal(sessions, 1, "a tool-set change must not create a new ACP session");
  assert.equal(prompts, 3, "each turn must dispatch exactly one prompt");
  console.log("Tool-set additions and removals stay on one warm ACP session: PASS");
} finally {
  await runtime.close();
}
