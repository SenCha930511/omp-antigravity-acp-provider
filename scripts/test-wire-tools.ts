import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AntigravityRuntime, PERMISSION_RESULT_KIND, PERMISSION_TOOL_NAME, TierConnection, Type } from "../extension/runtime.mjs";
import { estimateContextTokens } from "../extension/runtime/prompt.ts";

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
const permissionTool = {
  name: PERMISSION_TOOL_NAME,
  description: "Answer a pending Antigravity permission request.",
  parameters: Type.Object({ requestId: Type.String({ minLength: 1 }) }),
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

async function run(
  messages: any[],
  target: AntigravityRuntime = runtime,
  availableTools: Array<typeof tools.read | typeof permissionTool> = [tools.read],
  sessionId = "wire-tools",
): Promise<{ message: any; events: any[] }> {
  const events: any[] = [];
  let message: any;
  for await (const event of target.stream(model, { messages, tools: availableTools }, { sessionId }).stream) {
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

  const initialContextTokens = estimateContextTokens({
    messages: [user("WIRE_TOOL_TEST")],
    tools: [tools.read],
  });
  const largeToolResult = `TOOL_RESULT:${"x".repeat(20_000)}`;
  const secondContext = {
    messages: [user("WIRE_TOOL_TEST"), first.message, toolResult(call, largeToolResult)],
    tools: [tools.read],
  };
  const second = await run(secondContext.messages);
  const expectedContextTokens = estimateContextTokens(secondContext);
  const text = second.message.content.filter((block: { type: string; text?: string }) => block.type === "text").map((block: { type: string; text?: string }) => block.text).join("");
  assert.match(text, /TOOL:TOOL_RESULT/, "the same ACP turn must continue with the OMP tool result");
  assert.equal(second.message.stopReason, "stop");
  assert.equal(second.message.usage.contextTokens, expectedContextTokens,
    "fallback usage must estimate the full continuation context, including the large tool result");
  assert.equal(second.message.usage.contextTokensSource, "estimate");
  assert.ok(expectedContextTokens > initialContextTokens + 1_000,
    "the continuation estimate must materially exceed the initial-request estimate");
  console.log("Wire tool call through the real MCP bridge and continuation: PASS");
} finally {
  await runtime.close();
}

const permissionRuntime = new AntigravityRuntime(options => new TierConnection({
  ...options,
  command: process.execPath,
  args: [path.join(root, "scripts/fake-agy.mjs")],
}), "yolo");
const permissionTools = [tools.read, permissionTool];

try {
  const permissionRequest = user("WIRE_IDENTITY_PERMISSION_TEST");
  const first = await run([permissionRequest], permissionRuntime, permissionTools, "wire-permission-fallback");
  const call = first.events.find(event => event.type === "toolcall_end")?.toolCall;
  assert.ok(call, "the matching ACP identity permission request must produce an OMP permission tool call");
  assert.equal(call.name, PERMISSION_TOOL_NAME);
  assert.equal(first.message.stopReason, "toolUse");

  const initialContextTokens = estimateContextTokens({ messages: [permissionRequest], tools: permissionTools });
  const largePermissionResult = `Permission: Allow once\n${"p".repeat(20_000)}`;
  const grantedPermission = {
    ...toolResult(call, largePermissionResult),
    details: {
      kind: PERMISSION_RESULT_KIND,
      requestId: call.id,
      optionId: "allow_once",
      cancelled: false,
    },
  };
  const permissionContext = {
    messages: [permissionRequest, first.message, grantedPermission],
    tools: permissionTools,
  };
  const second = await run(permissionContext.messages, permissionRuntime, permissionTools, "wire-permission-fallback");
  const expectedContextTokens = estimateContextTokens(permissionContext);
  assert.ok(second.message.content.some((block: { type: string; text?: string }) =>
    block.type === "text" && block.text?.includes("PERMISSION:selected:allow_once")),
  "the concrete OMP result must resolve the pending ACP permission request");
  assert.equal(second.message.stopReason, "stop");
  assert.equal(second.message.usage.contextTokens, expectedContextTokens,
    "fallback usage must re-estimate the full context after the actual permission result");
  assert.equal(second.message.usage.contextTokensSource, "estimate");
  assert.ok(expectedContextTokens > initialContextTokens + 1_000,
    "the granted-permission continuation must materially exceed its initial-request estimate");
  console.log("Wire permission continuation with fresh fallback context: PASS");
} finally {
  await permissionRuntime.close();
}

const guardRuntime = new AntigravityRuntime(options => new TierConnection({
  ...options,
  command: process.execPath,
  args: [path.join(root, "scripts/fake-agy.mjs")],
}), "yolo");

const messageText = (result: { message: any }) =>
  (result.message.content ?? [])
    .filter((block: { type: string }) => block.type === "text")
    .map((block: { text?: string }) => block.text)
    .join("");

try {
  const aliasRequest = user("WIRE_TOOL_ALIAS_TEST");
  const first = await run([aliasRequest], guardRuntime, [tools.read], "wire-tool-alias");
  const call = first.events.find(event => event.type === "toolcall_end")?.toolCall;
  assert.ok(call, "the alias call must pass schema validation after the rename and park as an OMP tool call");
  assert.equal(call.name, "read");
  assert.deepEqual(call.arguments, { path: "/wire-alias" });
  assert.equal(first.message.stopReason, "toolUse");

  const completed = await run([aliasRequest, first.message, toolResult(call, "ALIAS_OK")], guardRuntime, [tools.read], "wire-tool-alias");
  assert.match(messageText(completed), /TOOL:ALIAS_OK/, "the renamed call must complete through the same ACP turn");
  assert.equal(completed.message.stopReason, "stop");

  const rejected = await run([user("WIRE_TOOL_MISSING_TEST")], guardRuntime, [tools.read], "wire-tool-missing");
  assert.equal(rejected.message.stopReason, "stop", "a call missing a required key must not park as an OMP tool call");
  const rejection = messageText(rejected);
  assert.match(rejection, /missing required path/);
  assert.match(rejection, /Expected signature: pi_read\(path: string\)/);
  console.log("Wire tool-argument guard (alias rename, missing-key signature): PASS");
} finally {
  await guardRuntime.close();
}
