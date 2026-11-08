import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AntigravityRuntime, TierConnection, Type } from "../extension/runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const model = {
  id: "gemini-3.8-flash",
  name: "Flash",
  api: "antigravity-acp",
  provider: "antigravity-acp",
  contextWindow: 524288,
  maxTokens: 32000,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const tools = {
  read: {
    name: "read",
    description: "Read a synthetic path.",
    parameters: Type.Object({ path: Type.String() }),
  },
};

const runtime: any = new AntigravityRuntime(options => new TierConnection({
  ...options,
  command: process.execPath,
  args: [path.join(root, "scripts/fake-agy.mjs")],
}), "yolo");

const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });
const toolResult = (call: any, text: string) => ({
  role: "toolResult",
  toolCallId: call.id,
  toolName: call.name,
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 3,
});

async function run(messages: any[]): Promise<{ message: any; events: any[] }> {
  const events: any[] = [];
  let message: any;
  for await (const event of runtime.stream(model, { messages, tools: [tools.read] }, { sessionId: "wire-tools" }).stream) {
    events.push(event);
    if (event.type === "done") message = event.message;
  }
  return { message, events };
}

try {
  const first = await run([user("WIRE_TOOL_TEST")]);
  const call = first.events.find(event => event.type === "toolcall_end")?.toolCall;
  assert.ok(call, "the fake must reach the real MCP bridge and produce one OMP tool call");
  assert.equal(call.name, "read");
  assert.equal(first.message.stopReason, "toolUse");

  const second = await run([user("WIRE_TOOL_TEST"), first.message, toolResult(call, "TOOL_RESULT")]);
  const text = second.message.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("");
  assert.match(text, /TOOL:TOOL_RESULT/, "the same ACP turn must continue with the OMP tool result");
  assert.equal(second.message.stopReason, "stop");
  console.log("Wire tool call through the real MCP bridge and continuation: PASS");
} finally {
  await runtime.close();
}
