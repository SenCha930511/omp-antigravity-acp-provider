import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AntigravityRuntime, TierConnection, Type } from "../extension/runtime.mjs";
process.env.OMP_ACP_STEER_GRACE_MS = "0";

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
const updates: any[] = [];
let partialResolve: (() => void) | undefined;
const runtime: any = new AntigravityRuntime(options => new TierConnection({
  ...options,
  command: process.execPath,
  args: [path.join(root, "scripts/fake-agy.mjs")],
  handlers: {
    ...(options.handlers ?? {}),
    onUpdate: async (notification: any) => {
      updates.push(notification);
      const update = notification.update;
      if (partialResolve && update?.sessionUpdate === "agent_message_chunk" && update.content?.text === "PARTIAL_CANCEL") {
        partialResolve();
        partialResolve = undefined;
      }
      await options.handlers?.onUpdate?.(notification);
    },
  },
}), "yolo", undefined, 10);

const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });
const toolResult = (call: any, text: string) => ({
  role: "toolResult",
  toolCallId: call.id,
  toolName: call.name,
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 3,
});

async function run(messages: any[], sessionId = "wire-relay", selectedTools = [tools.read], signal?: AbortSignal): Promise<{ message: any; error: any; events: any[] }> {
  const events: any[] = [];
  let message: any;
  let error: any;
  for await (const event of runtime.stream(model, { messages, tools: selectedTools }, { sessionId, signal }).stream) {
    events.push(event);
    if (event.type === "done") message = event.message;
    if (event.type === "error") error = event.error;
  }
  return { message, error, events };
}

try {
  const first = await run([user("WIRE_TOOL_TEST")]);
  const calls = first.events.filter(event => event.type === "toolcall_end");
  assert.equal(calls.length, 1, "the relay must create exactly one OMP tool call");
  const call = calls[0].toolCall;
  assert.equal(first.message.stopReason, "toolUse");

  const second = await run([user("WIRE_TOOL_TEST"), first.message, toolResult(call, "TOOL_RESULT")]);
  const newCalls = second.events.filter(event => event.type === "toolcall_end");
  assert.equal(newCalls.length, 0, "await_result must not create a second OMP tool call");
  const text = second.message.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("");
  assert.match(text, /TOOL:TOOL_RESULT/, "the control tool must receive the same original result");
  assert.equal(second.message.stopReason, "stop");
  console.log("Relay returns the same result without a second OMP tool call: PASS");

  const batchFirst = await run([user("WIRE_TOOL_BATCH_TEST")], "wire-batch");
  const batchCalls = batchFirst.events
    .filter(event => event.type === "toolcall_end")
    .map(event => event.toolCall);
  assert.equal(batchCalls.length, 2, "two parallel tools must produce two OMP tool calls");
  const batchSecond = await run([
    user("WIRE_TOOL_BATCH_TEST"),
    batchFirst.message,
    toolResult(batchCalls[1], "SECOND_RESULT"),
    toolResult(batchCalls[0], "FIRST_RESULT"),
  ], "wire-batch");
  assert.equal(batchSecond.events.filter(event => event.type === "toolcall_end").length, 0);
  const batchText = batchSecond.message.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("");
  assert.match(batchText, /FIRST:FIRST_RESULT/);
  assert.match(batchText, /SECOND:SECOND_RESULT/);
  console.log("Relay preserves two parallel results in reverse order: PASS");

  updates.length = 0;
  const partial = Promise.withResolvers<void>();
  partialResolve = partial.resolve;
  const controller = new AbortController();
  const cancelledRun = run([user("WIRE_CANCEL_TEST")], "wire-cancel", [tools.read], controller.signal);
  await partial.promise;
  controller.abort();
  const cancelled = await cancelledRun;
  assert.equal(cancelled.error?.stopReason, "aborted");
  console.log("Relay cancellation settles the original prompt: PASS");

  const earlyFirst = await run([user("WIRE_EARLY_END_TEST")], "wire-early");
  const earlyCall = earlyFirst.events.find(event => event.type === "toolcall_end")?.toolCall;
  assert.ok(earlyCall, "early end must still produce the original OMP tool call");
  const earlySecond = await run([
    user("WIRE_EARLY_END_TEST"),
    earlyFirst.message,
    toolResult(earlyCall, "EARLY_RESULT"),
  ], "wire-early");
  assert.equal(
    earlySecond.events.filter(event => event.type === "toolcall_end").length,
    0,
    "orphan recovery must not create a second OMP tool call",
  );
  const earlyText = earlySecond.message.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("");
  assert.match(earlyText, /EARLY_END_CONTINUED/, "orphan recovery must deliver the result in a new ACP turn");

  const refused = await run([user("WIRE_REFUSAL_TEST")], "wire-refusal");
  assert.equal(refused.error?.stopReason, "error");
  assert.match(refused.error?.errorMessage ?? "", /refused/i);
  assert.equal(refused.events.some(event => event.type === "done"), false);
  console.log("Provider refusal is an explicit failure: PASS");

  const collision = await run([user("WIRE_TOOL_TEST")], "wire-collision", [{
    name: "omp_await_result",
    description: "Collision",
    parameters: Type.Object({ call_id: Type.String() }),
  }]);
  assert.match(collision.error?.errorMessage ?? "", /collides with the relay control tool/);
  console.log("Relay control name collision fails closed: PASS");

  const syncFirst = await run([user("WIRE_EMPTY_TEST")], "wire-collision-sync", [tools.read]);
  assert.equal(syncFirst.error, undefined);
  const syncCollision = await run([
    user("WIRE_EMPTY_TEST"),
    syncFirst.message,
    user("WIRE_EMPTY_TEST"),
  ], "wire-collision-sync", [tools.read, {
    name: "omp_await_result",
    description: "Collision",
    parameters: Type.Object({ call_id: Type.String() }),
  }]);
  assert.match(syncCollision.error?.errorMessage ?? "", /collides with the relay control tool/);
  console.log("Mid-session relay control name collision fails closed: PASS");

  const empty = await run([user("WIRE_EMPTY_TEST")], "wire-empty");
  assert.equal(empty.error, undefined);
  assert.equal(empty.message.stopReason, "stop");
  const emptyText = empty.message.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("");
  assert.equal(emptyText, "");

  const thoughtOnly = await run([user("WIRE_THOUGHT_ONLY_TEST")], "wire-thought");
  assert.equal(thoughtOnly.error, undefined);
  assert.equal(thoughtOnly.message.stopReason, "stop");
  assert.equal(thoughtOnly.message.content.some((block: any) => block.type === "thinking"), true);
  assert.equal(thoughtOnly.message.content.some((block: any) => block.type === "text" && block.text.length > 0), false);
  console.log("Empty and thought-only end_turn remain non-errors: PASS");

  const parkedFirst = await run([user("WIRE_TOOL_TEST")], "wire-close");
  assert.ok(parkedFirst.events.find(event => event.type === "toolcall_end"));
  const closeStarted = performance.now();
  await runtime.close();
  assert.ok(performance.now() - closeStarted < 2000, "runtime.close must not wait for a parked relay client");
  console.log("Runtime close settles a parked relay call: PASS");
} finally {
  await runtime.close();
}
