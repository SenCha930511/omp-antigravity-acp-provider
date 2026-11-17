import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentNoticeFilter, classifyOutputLimitNotice, isRefused429 } from "../extension/agent-notices.ts";
import { TierConnection } from "../extension/tier-connection.ts";
import { AntigravityAcpConnection } from "../extension/runtime/acp/connection.ts";

test("classifies the output-limit notice and its retry suffix", () => {
  const full = "Your previous response was cut off because it exceeded the output token limit Please continue from where you left off, keeping your response shorter";
  assert.equal(classifyOutputLimitNotice(`${full} Retries remaining: 2`), "drop");
  assert.equal(classifyOutputLimitNotice("Your previous response was cut off"), "hold");
  assert.equal(classifyOutputLimitNotice("Please continue from where you left off"), "hold");
  assert.equal(classifyOutputLimitNotice("Retries remaining: 3"), "drop");
  assert.equal(classifyOutputLimitNotice("Here is the answer."), "emit");
});

test("reports a dropped output-limit notice once", () => {
  const filter = new AgentNoticeFilter();
  filter.accept("s", "your previous response was cut off because it exceeded the output token limit");
  assert.equal(filter.consumeOutputLimitNotice("s"), true);
  assert.equal(filter.consumeOutputLimitNotice("s"), false);
  filter.accept("s", "⚠ API error (attempt 1): upstream");
  assert.equal(filter.consumeOutputLimitNotice("s"), false);
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

test("drops and captures each terminal notice line", () => {
  for (const line of [
    "⚠ Agent execution terminated due to error.",
    "⚠ There was a network issue connecting to the server, please try again.",
    "⚠ Your AI credits balance is too low to continue.",
  ]) {
    const filter = new AgentNoticeFilter();
    assert.equal(filter.accept("s", `answer\n${line}\nafter`), "answer\nafter");
    assert.equal(filter.dropped, 1);
    assert.equal(filter.terminalNotice("s"), line);
  }
});

test("captures a terminal banner that ends the stream without a newline", () => {
  const filter = new AgentNoticeFilter();
  assert.equal(filter.accept("s", "⚠ Agent execution terminated due to error."), undefined);
  assert.equal(filter.flush("s"), undefined);
  assert.equal(filter.dropped, 1);
  assert.equal(filter.terminalNotice("s"), "⚠ Agent execution terminated due to error.");
});

test("holds a split terminal banner until the chunk settles it", () => {
  const filter = new AgentNoticeFilter();
  assert.equal(filter.accept("s", "answer\n⚠ Your AI credits bal"), "answer");
  assert.equal(filter.accept("s", "ance is too low to continue.\nnext"), "\nnext");
  assert.equal(filter.dropped, 1);
  assert.equal(filter.terminalNotice("s"), "⚠ Your AI credits balance is too low to continue.");
});

test("drops and captures the RESOURCE_EXHAUSTED 429 banner", () => {
  const filter = new AgentNoticeFilter();
  const banner = "⚠ RESOURCE_EXHAUSTED (code 429): Quota resource has been exhausted.";
  assert.equal(filter.accept("s", `before\n${banner}\nafter`), "before\nafter");
  assert.equal(filter.dropped, 1);
  assert.equal(filter.terminalNotice("s"), undefined);
  const capture = filter.captured("s");
  assert.equal(capture.apiDetail, banner);
  assert.equal(capture.refusedDetail, banner);
  assert.equal(isRefused429(capture.refusedDetail), true);
});

test("holds a partial 429 banner and resolves it with the detail captured", () => {
  const filter = new AgentNoticeFilter();
  assert.equal(filter.accept("s", "\n⚠ RESOURCE_EXHAUS"), undefined);
  assert.equal(filter.accept("s", "TED (code 429): Quota resource has been exhausted.\nafter"), "\nafter");
  assert.equal(filter.dropped, 1);
  assert.equal(filter.captured("s").refusedDetail, "⚠ RESOURCE_EXHAUSTED (code 429): Quota resource has been exhausted.");
});

test("keeps an interruption a notice but captures invalid output as terminal", () => {
  const filter = new AgentNoticeFilter();
  assert.equal(filter.accept("s", "⚠ The stream was interrupted. Please continue the task you were working on.\n"), undefined);
  assert.equal(filter.terminalNotice("s"), undefined);
  // Invalid output means the turn produced nothing usable: a banner-only
  // end_turn must fail with evidence instead of looking like model silence.
  assert.equal(filter.accept("s", "⚠ Model produced invalid output.\n"), undefined);
  assert.equal(filter.dropped, 2);
  assert.equal(filter.terminalNotice("s"), "⚠ Model produced invalid output.");
  assert.equal(filter.captured("s").apiDetail, undefined);
  assert.equal(filter.consumeCaptured("s").terminal, "⚠ Model produced invalid output.");
});

test("holds a split invalid-output banner until the chunk settles it", () => {
  const filter = new AgentNoticeFilter();
  assert.equal(filter.accept("s", "⚠ Model produced inva"), undefined);
  assert.equal(filter.accept("s", "lid output.\n"), undefined);
  assert.equal(filter.dropped, 1);
  assert.equal(filter.terminalNotice("s"), "⚠ Model produced invalid output.");
});

test("passes notice-looking lines inside a code fence through untouched", () => {
  const filter = new AgentNoticeFilter();
  const fenced = "```ts\n⚠ Your AI credits balance is too low to continue.\n```";
  assert.equal(filter.accept("s", fenced), fenced);
  assert.equal(filter.dropped, 0);
  assert.equal(filter.terminalNotice("s"), undefined);
  assert.equal(filter.accept("s", "\n⚠ Your AI credits balance is too low to continue.\n"), "\n");
  assert.equal(filter.dropped, 1);
});

test("keeps fence and capture state isolated per session", () => {
  const filter = new AgentNoticeFilter();
  assert.equal(filter.accept("a", "```\n"), "```\n");
  assert.equal(filter.accept("b", "⚠ Agent execution terminated due to error.\n"), undefined);
  assert.equal(filter.accept("a", "⚠ Agent execution terminated due to error.\n"), "⚠ Agent execution terminated due to error.\n");
  assert.equal(filter.terminalNotice("b"), "⚠ Agent execution terminated due to error.");
  assert.equal(filter.terminalNotice("a"), undefined);
  assert.equal(filter.accept("a", "```\n"), "```\n");
  assert.equal(filter.accept("a", "⚠ Model produced invalid output.\n"), undefined);
  assert.equal(filter.dropped, 2);
});

test("forget clears stream state but keeps the finished turn's captures", () => {
  const filter = new AgentNoticeFilter();
  filter.accept("s", "```\n");
  assert.equal(filter.accept("s", "⚠ Agent execution terminated due to error.\n"), "⚠ Agent execution terminated due to error.\n");
  filter.forget("s");
  assert.equal(filter.accept("s", "⚠ Agent execution terminated due to error.\n"), undefined);
  assert.equal(filter.terminalNotice("s"), "⚠ Agent execution terminated due to error.");
});

test("consumeCaptured returns and resets the captured record", () => {
  const filter = new AgentNoticeFilter();
  filter.accept("s", "⚠ RESOURCE_EXHAUSTED (code 429): Resource has been exhausted.\n");
  const first = filter.consumeCaptured("s");
  assert.equal(first.terminal, undefined);
  assert.equal(first.refusedDetail, "⚠ RESOURCE_EXHAUSTED (code 429): Resource has been exhausted.");
  assert.equal(filter.terminalNotice("s"), undefined);
  assert.deepEqual(filter.consumeCaptured("s"), { terminal: undefined, apiDetail: undefined, refusedDetail: undefined });
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

test("TierConnection drops a stale capture before the next prompt", async () => {
  const connection: any = new TierConnection({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    handlers: { onUpdate: async () => undefined },
  });
  const original = AntigravityAcpConnection.prototype.prompt;
  AntigravityAcpConnection.prototype.prompt = async () => ({ stopReason: "end_turn" });
  try {
    const banner = (sessionId: string) => ({
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "⚠ Agent execution terminated due to error.\n" } },
    });
    await connection.handlers.onUpdate(banner("stale"));
    await connection.handlers.onUpdate(banner("kept"));
    await connection.prompt({ sessionId: "stale", prompt: [] });
    assert.equal(connection.consumeNoticeCapture("stale"), undefined,
      "a turn that threw before its capture was consumed must not leak it into the next turn");
    assert.equal(connection.consumeNoticeCapture("kept")?.terminal, "⚠ Agent execution terminated due to error.");
  } finally {
    AntigravityAcpConnection.prototype.prompt = original;
    await connection.close();
  }
});

test("TierConnection flushes a held prefix at the terminal boundary", async () => {
  const seen: any[] = [];
  const connection: any = new TierConnection({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    handlers: { onUpdate: async (notification: any) => { seen.push(notification); } },
  });
  const original = AntigravityAcpConnection.prototype.prompt;
  let calls = 0;
  AntigravityAcpConnection.prototype.prompt = async function () {
    calls++;
    await this.handlers.onUpdate({
      sessionId: "session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: calls === 1 ? "your previous response was cut off" : "second" },
      },
    });
    return { stopReason: "end_turn" };
  };
  try {
    await connection.prompt({ sessionId: "session", prompt: [] });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].update.content.text, "your previous response was cut off");
    await connection.handlers.onUpdate({
      sessionId: "session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } },
    });
    assert.equal(seen.length, 1, "a late chunk from the closed turn must be ignored");
    await connection.prompt({ sessionId: "session", prompt: [] });
    assert.equal(seen.length, 2);
    assert.equal(seen[1].update.content.text, "second");
  } finally {
    AntigravityAcpConnection.prototype.prompt = original;
    await connection.close();
  }
});

test("TierConnection drops a complete notice at the terminal boundary", async () => {
  const seen: any[] = [];
  const connection: any = new TierConnection({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    handlers: { onUpdate: async (notification: any) => { seen.push(notification); } },
  });
  const original = AntigravityAcpConnection.prototype.prompt;
  AntigravityAcpConnection.prototype.prompt = async function () {
    await this.handlers.onUpdate({
      sessionId: "session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "your previous response was cut off because it exceeded the output token limit" },
      },
    });
    return { stopReason: "end_turn" };
  };
  try {
    await connection.prompt({ sessionId: "session", prompt: [] });
    assert.equal(seen.length, 0);
  } finally {
    AntigravityAcpConnection.prototype.prompt = original;
    await connection.close();
  }
});

test("TierConnection flushes a held prefix before a tool update", async () => {
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
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "your previous response was cut off" } },
    });
    await connection.handlers.onUpdate({
      sessionId: "session",
      update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Read", status: "pending" },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].update.content.text, "your previous response was cut off");
  } finally {
    await connection.close();
  }
});
