import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alignContextTokens,
  applyCompactionUpdate,
  formatCompactionNotice,
} from "../extension/acp-compaction.ts";
import { AntigravityAcpConnection } from "../extension/vendor/pi-antigravity-acp-provider/src/acp/connection.ts";
import { TierConnection } from "../extension/tier-connection.ts";

function bareConnection() {
  const connection: any = Object.create(TierConnection.prototype);
  connection.compactions = new Map();
  return connection;
}

test("ACP compaction chunks and upserts become one terminal notification", () => {
  const connection = bareConnection();
  connection.recordCompaction("session", {
    sessionUpdate: "compaction_summary_chunk",
    compactionId: "compact-1",
    content: { type: "text", text: "Earlier decisions: " },
  });
  connection.recordCompaction("session", {
    sessionUpdate: "compaction_summary_chunk",
    compactionId: "compact-1",
    content: { type: "text", text: "keep the API contract." },
  });
  let notices = connection.takeCompactionNotices();
  assert.deepEqual(notices, [], "in-progress compactions must not notify yet");

  connection.recordCompaction("session", {
    sessionUpdate: "compaction_update",
    compactionId: "compact-1",
    status: "completed",
  });
  notices = connection.takeCompactionNotices();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].status, "completed");
  assert.equal(notices[0].summary, "Earlier decisions: keep the API contract.");
  assert.deepEqual(connection.takeCompactionNotices(), [], "a completed compaction is notified once");
});

test("compaction failures surface the error and clear on explicit null", () => {
  const failed = applyCompactionUpdate(undefined, "s", {
    compactionId: "c", status: "failed", error: "quota unavailable",
  });
  assert.equal(failed?.error, "quota unavailable");
  const cleared = applyCompactionUpdate(failed, "s", {
    compactionId: "c", status: "failed", error: null,
  });
  assert.equal(cleared?.error, undefined);
  assert.match(formatCompactionNotice({ sessionId: "s", compactionId: "c", status: "failed", summary: "", error: "quota unavailable" }), /quota unavailable/);
});

test("ACP context size is normalized to OMP's model context window", () => {
  assert.equal(alignContextTokens(75, 1_000, 1_000), 75);
  assert.equal(alignContextTokens(500, 1_000, 524_288), 262_144);
  assert.equal(alignContextTokens(500, 1_000, 262_144), 131_072);
  assert.equal(alignContextTokens(500, 0, 524_288), 500);
  assert.equal(alignContextTokens(-1, 1_000, 524_288), -1);
  assert.equal(alignContextTokens(500, 1_000, undefined), 500);
});

test("TierConnection reports calibrated context occupancy to OMP", async () => {
  const original = AntigravityAcpConnection.prototype.prompt;
  AntigravityAcpConnection.prototype.prompt = async () => ({ stopReason: "end_turn" });
  const connection: any = Object.assign(Object.create(TierConnection.prototype), {
    activePrompts: 0,
    usageQueryCount: 0,
    usageQueryMs: 0,
    contextUsage: new Map([["session", { used: 500, size: 1_000 }]]),
    ompContextWindows: new Map([["session", 524_288]]),
    compactions: new Map(),
    usageStatus: new Map(),
    usageBaselines: new Map(),
    usageCommands: new Set(),
    usageCaptures: new Map(),
    firstOutput: new Map(),
    steerMuted: new Set(),
    steerActivity: new Map(),
  });
  try {
    const response = await connection.prompt({ sessionId: "session", prompt: [] });
    assert.equal(response._meta.ompContextTokens, 262_144);
    assert.deepEqual(response._meta.ompAcpContext, { used: 500, size: 1_000, ompContextWindow: 524_288 });
  } finally {
    AntigravityAcpConnection.prototype.prompt = original;
  }
});

test("TierConnection forwards normal ACP updates through the presentation filter", async () => {
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
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].update.content.text, "hello");
  } finally {
    await connection.close();
  }
});

test("TierConnection aborts the upstream prompt immediately for explicit cancellation", async () => {
  const original = AntigravityAcpConnection.prototype.prompt;
  let upstreamSignal: AbortSignal | undefined;
  const started = Promise.withResolvers<void>();
  AntigravityAcpConnection.prototype.prompt = async (_request: any, signal?: AbortSignal) => {
    upstreamSignal = signal;
    started.resolve();
    return new Promise((_, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const connection: any = Object.assign(Object.create(TierConnection.prototype), {
    activePrompts: 0,
    usageMode: "off",
    usageQueryCount: 0,
    usageQueryMs: 0,
    steerMode: "queue",
    steerTimings: { idleMs: 60_000, maxMs: 300_000 },
    contextUsage: new Map(),
    ompContextWindows: new Map(),
    compactions: new Map(),
    usageStatus: new Map(),
    usageBaselines: new Map(),
    usageCommands: new Set(),
    usageCaptures: new Map(),
    firstOutput: new Map(),
    steerMuted: new Set(),
    steerActivity: new Map(),
  });
  try {
    const cancelled = new AbortController();
    const pending = connection.prompt({ sessionId: "session", prompt: [] }, cancelled.signal);
    await started.promise;
    cancelled.abort("user cancelled");
    await assert.rejects(pending);
    assert.equal(upstreamSignal?.aborted, true, "explicit cancellation must not wait for the grace");
    assert.equal(upstreamSignal?.reason, "user cancelled");
    assert.equal(connection.steerMuted.has("session"), true, "cancellation must freeze late ACP output");
  } finally {
    AntigravityAcpConnection.prototype.prompt = original;
  }
});
