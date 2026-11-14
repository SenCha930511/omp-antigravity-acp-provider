import assert from "node:assert/strict";
import test from "node:test";
import { AntigravityRuntime } from "../extension/runtime.mjs";

const runtime = new AntigravityRuntime();
const normalize = (message: unknown) => Reflect.get(runtime, "ompNormalizeAssistantForBoundary").call(runtime, message);

test("assistant boundary accepts string content and preserves real tool calls", () => {
  const text = normalize({ role: "assistant", content: "PLAIN_TEXT" });
  assert.deepEqual(text.content, [{ type: "text", text: "PLAIN_TEXT" }]);
  assert.equal(text.provider, "antigravity-acp");
  assert.equal(text.model, "");

  const withTool = normalize({ role: "assistant", content: [
    { type: "thinking", thinking: "discard historical thought" },
    { type: "text", text: "ANSWER" },
    { type: "toolCall", id: "call-1", name: "task", arguments: { count: 3, retries: [1, 2] } },
  ] });
  assert.deepEqual(withTool.content, [
    { type: "text", text: "ANSWER" },
    { type: "toolCall", id: "call-1", name: "task", arguments: { count: 3, retries: [1, 2] } },
  ]);
});

test("assistant boundary drops invalid tool calls instead of fabricating them", () => {
  for (const content of [
    undefined,
    [{ type: "toolCall", id: 12, name: "task", arguments: {} }],
    [{ type: "toolCall", id: "call-1", name: "task", arguments: { invalid: Number.NaN } }],
    [{ type: "toolCall", id: "call-1", name: "task", arguments: null }],
  ]) {
    const result = normalize({ role: "assistant", content });
    assert.deepEqual(result.content, [{ type: "text", text: "" }]);
  }
});

test("assistant boundary accepts repeated object aliases but rejects cycles", () => {
  const shared = { nested: [1, 2] };
  const aliased = normalize({ role: "assistant", content: [
    { type: "toolCall", id: "call-alias", name: "task", arguments: { left: shared, right: shared } },
  ] });
  assert.deepEqual(aliased.content, [
    { type: "toolCall", id: "call-alias", name: "task", arguments: { left: shared, right: shared } },
  ]);

  const cyclic: Record<string, unknown> = { value: 1 };
  cyclic.self = cyclic;
  const rejected = normalize({ role: "assistant", content: [
    { type: "toolCall", id: "call-cycle", name: "task", arguments: cyclic },
  ] });
  assert.deepEqual(rejected.content, [{ type: "text", text: "" }]);
});
