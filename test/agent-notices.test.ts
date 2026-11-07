import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentNoticeFilter, classifyOutputLimitNotice } from "../extension/agent-notices.ts";
import { TierConnection } from "../extension/tier-connection.ts";

test("classifies the output-limit notice and its retry suffix", () => {
  const full = "Your previous response was cut off because it exceeded the output token limit Please continue from where you left off, keeping your response shorter";
  assert.equal(classifyOutputLimitNotice(`${full} Retries remaining: 2`), "drop");
  assert.equal(classifyOutputLimitNotice("Your previous response was cut off"), "hold");
  assert.equal(classifyOutputLimitNotice("Please continue from where you left off"), "hold");
  assert.equal(classifyOutputLimitNotice("Retries remaining: 3"), "drop");
  assert.equal(classifyOutputLimitNotice("Here is the answer."), "emit");
});

test("drops a retry notice and keeps ordinary text byte-for-byte", () => {
  const filter = new AgentNoticeFilter();
  assert.equal(filter.accept("s", "your previous response was cut off because it exceeded the output"), undefined);
  assert.equal(filter.accept("s", " token limit please continue from where you left off, keeping your response shorter"), undefined);
  assert.equal(filter.dropped, 1);
  assert.equal(filter.accept("s", "Hello "), "Hello ");
  assert.equal(filter.accept("s", "world."), "world.");
});

test("holds a split notice until the next chunk settles it", () => {
  const filter = new AgentNoticeFilter();
  assert.equal(filter.accept("s", "your previous response was cut off because it exceeded the output"), undefined);
  assert.equal(filter.accept("s", " token limit please continue from where you left off, keeping your response shorter"), undefined);
  assert.equal(filter.dropped, 1);
});

test("flush releases a prefix that was model text and counts a complete held notice", () => {
  const filter = new AgentNoticeFilter();
  assert.equal(filter.accept("s", "your previous response was cut off"), undefined);
  assert.equal(filter.flush("s"), "your previous response was cut off");
  assert.equal(filter.dropped, 0);

  assert.equal(filter.accept("s", "your previous response was cut off because it exceeded the output token limit"), undefined);
  assert.equal(filter.flush("s"), undefined);
  assert.equal(filter.dropped, 1);
});

test("keeps hold state isolated per session", () => {
  const filter = new AgentNoticeFilter();
  assert.equal(filter.accept("a", "your previous response was cut off"), undefined);
  assert.equal(filter.accept("b", "normal output"), "normal output");
  assert.equal(filter.flush("a"), "your previous response was cut off");
});

test("TierConnection filters notices before forwarding ACP updates", async () => {
  const seen: any[] = [];
  const connection: any = new TierConnection({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    handlers: { onUpdate: async (notification: any) => { seen.push(notification); } },
  });
  try {
    await connection.handlers.onUpdate({
      sessionId: "session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "⚠ API error (attempt 1): upstream" } },
    });
    assert.equal(seen.length, 0);
    await connection.handlers.onUpdate({
      sessionId: "session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].update.content.text, "answer");
  } finally {
    await connection.close();
  }
});
