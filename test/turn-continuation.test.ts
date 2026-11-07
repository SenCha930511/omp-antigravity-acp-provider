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
      return calls.length === 1 ? { stopReason: "max_tokens" } : { stopReason: "end_turn" };
    },
  };
  try {
    const response = await tier.prompt({ sessionId: "session", prompt: [{ type: "text", text: "hello" }] });
    assert.equal(response.stopReason, "end_turn");
    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt[0].text, /Continue exactly where your previous output stopped/);
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
