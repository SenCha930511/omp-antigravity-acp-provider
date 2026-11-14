import { test } from "node:test";
import assert from "node:assert/strict";
import { TierConnection } from "../extension/tier-connection.ts";

function connection(): any {
  return new TierConnection({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    handlers: {},
  });
}

test("continues a max_tokens turn on the same session", async () => {
  const tier = connection();
  const calls: any[] = [];
  tier.connection = {
    prompt: async (request: any) => {
      calls.push(request);
      return calls.length === 1
        ? { stopReason: "max_tokens", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, thoughtTokens: 2, cachedReadTokens: 3, cachedWriteTokens: 1 } }
        : { stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 7, totalTokens: 27, thoughtTokens: 4, cachedReadTokens: 5, cachedWriteTokens: 1 } };
    },
  };
  try {
    const response = await tier.prompt({ sessionId: "session", prompt: [{ type: "text", text: "hello" }] });
    assert.equal(response.stopReason, "end_turn");
    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt[0].text, /Continue exactly where your previous output stopped/);
    assert.deepEqual(response.usage, {
      inputTokens: 30,
      outputTokens: 12,
      totalTokens: 42,
      thoughtTokens: 6,
      cachedReadTokens: 8,
      cachedWriteTokens: 2,
    });
  } finally {
    await tier.close();
  }
});

test("does not continue when agy already reported its own output-limit notice", async () => {
  const tier = connection();
  let calls = 0;
  tier.connection = {
    prompt: async () => {
      calls++;
      await tier.handlers.onUpdate({
        sessionId: "session",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "your previous response was cut off because it exceeded the output token limit" } },
      });
      return { stopReason: "max_tokens" };
    },
  };
  try {
    const response = await tier.prompt({ sessionId: "session", prompt: [{ type: "text", text: "hello" }] });
    assert.equal(response.stopReason, "max_tokens");
    assert.equal(calls, 1);
  } finally {
    await tier.close();
  }
});

test("a throwing held-notice handler cannot leak active prompt accounting", async () => {
  const tier = connection();
  (tier as any).noticeHandler = async () => { throw new Error("notice delivery failed"); };
  tier.connection = {
    prompt: async () => {
      await tier.handlers.onUpdate({
        sessionId: "session",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "your previous response was cut off because it exceeded the output" } },
      });
      return { stopReason: "end_turn" };
    },
  };
  try {
    const response = await tier.prompt({ sessionId: "session", prompt: [{ type: "text", text: "hello" }] });
    assert.equal(response.stopReason, "end_turn");
    assert.equal(tier.activePrompts, 0);
  } finally {
    await tier.close();
  }
});

test("late updates cannot flush held notices after the turn closes", async () => {
  const tier = connection();
  const delivered: unknown[] = [];
  (tier as any).noticeHandler = async (notification: unknown) => { delivered.push(notification); };
  await tier.handlers.onUpdate({
    sessionId: "session",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "your previous response was cut off because it exceeded the output" } },
  });
  (tier as any).noticeClosed.add("session");
  await tier.handlers.onUpdate({ sessionId: "session", update: { sessionUpdate: "usage_update", used: 1, size: 2 } });
  assert.deepEqual(delivered, [], "a closed turn must not flush raw text through a late update");
  await (tier as any).emitHeldNotice("session", true);
  assert.equal(delivered.length, 1, "the terminal boundary may force one final flush");
  await tier.close();
});
