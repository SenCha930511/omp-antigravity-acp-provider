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
const read = {
  name: "read",
  description: "Read a synthetic path.",
  parameters: Type.Object({ path: Type.String() }),
};
const bash = {
  name: "bash",
  description: "Run a synthetic command.",
  parameters: Type.Object({ command: Type.String() }),
};

let sessions = 0;
const runtime: any = new AntigravityRuntime(options => {
  const connection: any = new TierConnection({
    ...options,
    command: process.execPath,
    args: [path.join(root, "scripts/fake-agy.mjs")],
  });
  const original = connection.newSession.bind(connection);
  connection.newSession = async (...args: unknown[]) => {
    sessions += 1;
    return original(...args);
  };
  return connection;
}, "yolo");

const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });

async function run(messages: any[], tools: any[]): Promise<any> {
  let message: any;
  for await (const event of runtime.stream(model, { messages, tools }, { sessionId: "wire-tools-list" }).stream) {
    if (event.type === "done") message = event.message;
  }
  return message;
}

const textOf = (message: any): string => message.content
  .filter((block: any) => block.type === "text")
  .map((block: any) => block.text)
  .join("");

try {
  const first = await run([user("WIRE_TOOLS_LIST_TEST")], [read]);
  assert.equal(textOf(first), "TOOLS:pi_read");

  const second = await run([
    user("WIRE_TOOLS_LIST_TEST"),
    first,
    user("WIRE_TOOLS_LIST_TEST"),
  ], [read, bash]);
  assert.equal(textOf(second), "TOOLS:pi_read,pi_bash");

  const third = await run([
    user("WIRE_TOOLS_LIST_TEST"),
    first,
    user("WIRE_TOOLS_LIST_TEST"),
    second,
    user("WIRE_TOOLS_LIST_TEST"),
  ], [bash]);
  assert.equal(textOf(third), "TOOLS:pi_bash");

  const fourth = await run([
    user("WIRE_TOOLS_LIST_TEST"),
    first,
    user("WIRE_TOOLS_LIST_TEST"),
    second,
    user("WIRE_TOOLS_LIST_TEST"),
    third,
    user("WIRE_TOOLS_LIST_TEST"),
  ], [read, bash]);
  assert.equal(textOf(fourth), "TOOLS:pi_read,pi_bash");
  assert.equal(sessions, 1, "tool-set refresh must keep one ACP session");
  console.log("MCP tools/list returns add, remove and restore on one ACP session: PASS");
} finally {
  await runtime.close();
}
