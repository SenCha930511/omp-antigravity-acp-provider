import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { usageFromPrompt } from "../extension/usage.ts";
import { resolveAntigravityAcpDirectory } from "../extension/runtime/acp/antigravity.ts";
import type { SessionCleanup } from "../extension/session-cleanup.ts";
import { conversationDbPath } from "../extension/usage-db.ts";
import { TierConnection, usageFromStepBatch } from "../extension/tier-connection.ts";

interface StepCounts {
  input: number;
  output: number;
  cachedWrite: number;
  cachedRead: number;
  thought: number;
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return bytes;
}

function varintField(tag: number, value: number): number[] {
  return [...varint(tag << 3), ...varint(value)];
}

function field(tag: number, payload: number[]): number[] {
  return [...varint((tag << 3) | 2), ...varint(payload.length), ...payload];
}

function metadata(usage: StepCounts): Uint8Array {
  return Uint8Array.from(field(9, [
    ...varintField(2, usage.input),
    ...varintField(3, usage.output),
    ...varintField(4, usage.cachedWrite),
    ...varintField(5, usage.cachedRead),
    ...varintField(9, usage.thought),
  ]));
}

// Fixtures live under a temporary ACP directory; no real session store is
// opened, created, or altered.
function createStore(acpDirectory: string, sessionId: string): string {
  const file = conversationDbPath(acpDirectory, sessionId);
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)");
  db.close();
  return file;
}

function insertStep(file: string, idx: number, usage: StepCounts): void {
  const db = new DatabaseSync(file);
  try {
    db.prepare("INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)")
      .run(idx, 15, 3, metadata(usage));
  } finally {
    db.close();
  }
}

async function temporaryStore(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-usage-query-"));
  return { dir, cleanup: async () => { await fs.rm(dir, { recursive: true, force: true }); } };
}

function createConnection(options: Record<string, unknown> = {}): any {
  return new TierConnection({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    handlers: {},
    ...options,
  });
}

test("the db batch maps to the provider input semantic without double counting", () => {
  const usage = usageFromStepBatch({
    maxIdx: 7,
    calls: 1,
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cachedWriteTokens: 5,
      cachedReadTokens: 40,
      thoughtTokens: 10,
      totalTokens: 165,
    },
  });
  assert.deepEqual(usage, {
    inputTokens: 140,
    outputTokens: 20,
    thoughtTokens: 10,
    cachedReadTokens: 40,
    cachedWriteTokens: 5,
    totalTokens: 165,
  });
  // The provider projection subtracts cache reads from the ACP input again, so
  // the prompt is billed once: 100 uncached input plus 40 cache reads.
  const projected = usageFromPrompt({ stopReason: "end_turn", usage });
  assert.equal(projected.input, 100);
  assert.equal(projected.cacheRead, 40);
  assert.equal(projected.output, 20);
  assert.equal(projected.reasoning, 10);
  assert.equal(projected.totalTokens, 165);
});

test("promptWithoutUsageDeltas bypasses supplemental usage accounting and prompt tracking", async () => {
  const connection = new TierConnection({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    handlers: {},
  });
  let calls = 0;
  Object.defineProperty(connection, "connection", { value: {
    prompt: async () => {
      calls++;
      return { stopReason: "end_turn" };
    },
  } });
  try {
    const response = await connection.promptWithoutUsageDeltas({ sessionId: "session", prompt: [{ type: "text", text: "/usage" }] });
    assert.equal(calls, 1);
    assert.equal(response.usage, undefined);
    assert.equal(connection.usageQueryCount, 0);
    assert.equal(connection.activePrompts, 0);
  } finally {
    await connection.close();
  }
});

test("concurrent /usage reads coalesce while a later read starts fresh", async () => {
  const connection: any = new TierConnection({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    handlers: {},
  });
  let calls = 0;
  connection.connection = {
    prompt: async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { stopReason: "end_turn" };
    },
  };
  try {
    const [first, second] = await Promise.all([
      connection.readUsage("session"),
      connection.readUsage("session"),
    ]);
    assert.equal(first, undefined);
    assert.equal(second, undefined);
    assert.equal(calls, 1, "a second caller must share the inflight read");
    await connection.readUsage("session");
    assert.equal(calls, 2, "a read after settlement must query again");
  } finally {
    await connection.close();
  }
});

test("a /usage timeout cancels the side turn without closing the live connection", async context => {
  const connection = createConnection();
  let cancels = 0;
  let closes = 0;
  connection.connection = {
    prompt: () => new Promise(() => {}),
    cancel: async () => { cancels++; },
  };
  connection.close = async () => { closes++; };
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = connection.readUsage("session");
    context.mock.timers.tick(5_000);
    await tick();
    assert.equal(await pending, undefined);
    assert.equal(cancels, 1, "the side turn is cancelled");
    context.mock.timers.tick(1_500);
    await tick();
    assert.equal(closes, 0, "the optional query must not close the warm connection");
  } finally {
    context.mock.timers.reset();
  }
});

test("a turn without /usage reports the local session db delta inline", async () => {
  const store = await temporaryStore();
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const file = createStore(store.dir, sessionId);
  insertStep(file, 4, { input: 900, output: 90, cachedWrite: 0, cachedRead: 0, thought: 0 });
  // The default usage mode suppresses /usage prompts; local token accounting
  // must still report the completed step without sending one.
  const connection = createConnection({ ompAcpDirectory: store.dir, ompUsageMode: "off" });
  const prompts: Array<{ prompt: Array<{ type: string; text?: string }> }> = [];
  connection.connection = {
    prompt: async (request: { prompt: Array<{ type: string; text?: string }> }) => {
      prompts.push(request);
      insertStep(file, 5, { input: 100, output: 20, cachedWrite: 5, cachedRead: 40, thought: 10 });
      return { stopReason: "end_turn" };
    },
  };
  try {
    const response = await connection.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });
    assert.deepEqual(response.usage, {
      inputTokens: 140,
      outputTokens: 20,
      thoughtTokens: 10,
      cachedReadTokens: 40,
      cachedWriteTokens: 5,
      totalTokens: 165,
    });
    assert.equal(prompts.length, 1, "the db fallback must not add a prompt");
    assert.equal(prompts[0].prompt[0].text, "hello");
    assert.equal(connection.usageQueryCount, 0, "the db fallback must not send /usage");
    assert.deepEqual(connection.usageStatus.get(sessionId), { source: "local session db (1 call)", cache: "reported" });
  } finally {
    await connection.close();
    await store.cleanup();
  }
});

test("the session db cursor is per session", async () => {
  const store = await temporaryStore();
  const first = createStore(store.dir, "00000000-0000-4000-8000-000000000002");
  const second = createStore(store.dir, "00000000-0000-4000-8000-000000000003");
  insertStep(first, 1, { input: 500, output: 50, cachedWrite: 0, cachedRead: 0, thought: 0 });
  insertStep(second, 8, { input: 700, output: 70, cachedWrite: 0, cachedRead: 0, thought: 0 });
  const connection = createConnection({ ompAcpDirectory: store.dir, ompUsageMode: "off" });
  connection.connection = {
    prompt: async (request: { sessionId: string }) => {
      if (request.sessionId === "00000000-0000-4000-8000-000000000002") insertStep(first, 2, { input: 10, output: 1, cachedWrite: 0, cachedRead: 0, thought: 0 });
      else insertStep(second, 9, { input: 20, output: 2, cachedWrite: 0, cachedRead: 0, thought: 0 });
      return { stopReason: "end_turn" };
    },
  };
  try {
    const a = await connection.prompt({ sessionId: "00000000-0000-4000-8000-000000000002", prompt: [{ type: "text", text: "a" }] });
    const b = await connection.prompt({ sessionId: "00000000-0000-4000-8000-000000000003", prompt: [{ type: "text", text: "b" }] });
    assert.equal(a.usage.inputTokens, 10);
    assert.equal(a.usage.totalTokens, 11);
    assert.equal(b.usage.inputTokens, 20);
    assert.equal(b.usage.totalTokens, 22);
  } finally {
    await connection.close();
    await store.cleanup();
  }
});

test("native response usage wins over the local session db", async () => {
  const store = await temporaryStore();
  const file = createStore(store.dir, "00000000-0000-4000-8000-000000000004");
  insertStep(file, 1, { input: 900, output: 90, cachedWrite: 0, cachedRead: 0, thought: 0 });
  let retries = 0;
  const connection = createConnection({
    ompAcpDirectory: store.dir,
    ompUsageMode: "off",
    ompUsageRetry: async () => { retries++; },
  });
  const native = { inputTokens: 7, outputTokens: 3, totalTokens: 10 };
  connection.connection = {
    prompt: async () => {
      insertStep(file, 2, { input: 800, output: 80, cachedWrite: 0, cachedRead: 0, thought: 0 });
      return { stopReason: "end_turn", usage: native };
    },
  };
  try {
    const response = await connection.prompt({ sessionId: "00000000-0000-4000-8000-000000000004", prompt: [{ type: "text", text: "hello" }] });
    assert.deepEqual(response.usage, native);
    assert.equal(retries, 0, "native usage must not trigger a db read");
    assert.deepEqual(connection.usageStatus.get("00000000-0000-4000-8000-000000000004"), { source: "ACP response", cache: "unknown" });
  } finally {
    await connection.close();
    await store.cleanup();
  }
});

test("an advertised /usage query keeps the official delta instead of the session db", async () => {
  const store = await temporaryStore();
  const file = createStore(store.dir, "00000000-0000-4000-8000-000000000005");
  insertStep(file, 3, { input: 1000, output: 100, cachedWrite: 0, cachedRead: 0, thought: 0 });
  const originalSetHandlers = TierConnection.prototype.setHandlers;
  let handler: ((notification: any) => Promise<void> | void) | undefined;
  TierConnection.prototype.setHandlers = function (handlers) {
    handler = handlers.onUpdate;
    return originalSetHandlers.call(this, handlers);
  };
  const connection = createConnection({ ompAcpDirectory: store.dir, ompUsageMode: "auto" });
  let usageQueries = 0;
  connection.connection = {
    prompt: async (request: { prompt: Array<{ text?: string }> }) => {
      if (request.prompt[0]?.text === "/usage") {
        usageQueries++;
        const totals = usageQueries === 1
          ? "**Session total:** 100 tokens (prompt: 80, completion: 20, thinking: 0, cached: 10)"
          : "**Session total:** 200 tokens (prompt: 180, completion: 20, thinking: 0, cached: 30)";
        await handler?.({ sessionId: "00000000-0000-4000-8000-000000000005", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: totals } } });
        return { stopReason: "end_turn" };
      }
      insertStep(file, 4, { input: 999, output: 99, cachedWrite: 0, cachedRead: 0, thought: 0 });
      return { stopReason: "end_turn" };
    },
  };
  try {
    await handler?.({
      sessionId: "00000000-0000-4000-8000-000000000005",
      update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "usage", description: "fixture" }] },
    });
    const response = await connection.prompt({ sessionId: "00000000-0000-4000-8000-000000000005", prompt: [{ type: "text", text: "hello" }] });
    assert.equal(usageQueries, 2, "the official path uses the baseline and post-turn reads");
    assert.deepEqual(response.usage, {
      inputTokens: 100,
      outputTokens: 0,
      thoughtTokens: 0,
      totalTokens: 100,
      cachedReadTokens: 20,
    });
    assert.equal(connection.usageStatus.get("00000000-0000-4000-8000-000000000005")?.source, "official /usage delta (main agent)");
  } finally {
    TierConnection.prototype.setHandlers = originalSetHandlers;
    await connection.close();
    await store.cleanup();
  }
});

test("a failed official /usage query degrades without a db fallback or extra prompt", async () => {
  const store = await temporaryStore();
  const file = createStore(store.dir, "00000000-0000-4000-8000-000000000006");
  insertStep(file, 3, { input: 1000, output: 100, cachedWrite: 0, cachedRead: 0, thought: 0 });
  const originalSetHandlers = TierConnection.prototype.setHandlers;
  let handler: ((notification: any) => Promise<void> | void) | undefined;
  TierConnection.prototype.setHandlers = function (handlers) {
    handler = handlers.onUpdate;
    return originalSetHandlers.call(this, handlers);
  };
  const connection = createConnection({ ompAcpDirectory: store.dir, ompUsageMode: "auto" });
  let usageQueries = 0;
  connection.connection = {
    prompt: async (request: { prompt: Array<{ text?: string }> }) => {
      if (request.prompt[0]?.text === "/usage") {
        usageQueries++;
        if (usageQueries === 1) {
          await handler?.({ sessionId: "00000000-0000-4000-8000-000000000006", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "**Session total:** 100 tokens (prompt: 80, completion: 20, thinking: 0, cached: 10)" } } });
          return { stopReason: "end_turn" };
        }
        throw new Error("usage query failed");
      }
      insertStep(file, 4, { input: 999, output: 99, cachedWrite: 0, cachedRead: 0, thought: 0 });
      return { stopReason: "end_turn" };
    },
  };
  try {
    await handler?.({
      sessionId: "00000000-0000-4000-8000-000000000006",
      update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "usage", description: "fixture" }] },
    });
    const response = await connection.prompt({ sessionId: "00000000-0000-4000-8000-000000000006", prompt: [{ type: "text", text: "hello" }] });
    assert.equal(response.usage, undefined);
    assert.equal(usageQueries, 2);
    assert.deepEqual(connection.usageStatus.get("00000000-0000-4000-8000-000000000006"), {
      source: "unavailable",
      cache: "unknown",
      error: "Official usage query failed or timed out",
    });
  } finally {
    TierConnection.prototype.setHandlers = originalSetHandlers;
    await connection.close();
    await store.cleanup();
  }
});

test("OMP_ACP_USAGE=off disables both the /usage query and the local session db", async () => {
  const store = await temporaryStore();
  const file = createStore(store.dir, "00000000-0000-4000-8000-000000000007");
  insertStep(file, 1, { input: 900, output: 90, cachedWrite: 0, cachedRead: 0, thought: 0 });
  const previous = process.env.OMP_ACP_USAGE;
  process.env.OMP_ACP_USAGE = "off";
  let retries = 0;
  const connection = createConnection({
    ompAcpDirectory: store.dir,
    ompUsageMode: "auto",
    ompUsageRetry: async () => { retries++; },
  });
  connection.connection = {
    prompt: async () => {
      insertStep(file, 2, { input: 800, output: 80, cachedWrite: 0, cachedRead: 0, thought: 0 });
      return { stopReason: "end_turn" };
    },
  };
  try {
    const response = await connection.prompt({ sessionId: "00000000-0000-4000-8000-000000000007", prompt: [{ type: "text", text: "hello" }] });
    assert.equal(response.usage, undefined);
    assert.equal(connection.usageQueryCount, 0, "the environment override must suppress /usage");
    assert.equal(retries, 0, "the environment override must not read the session db");
    assert.deepEqual(connection.usageStatus.get("00000000-0000-4000-8000-000000000007"), { source: "unavailable", cache: "unknown" });
  } finally {
    if (previous === undefined) delete process.env.OMP_ACP_USAGE; else process.env.OMP_ACP_USAGE = previous;
    await connection.close();
    await store.cleanup();
  }
});

test("the WAL retry window finds a step committed just after the response", async () => {
  const store = await temporaryStore();
  const file = createStore(store.dir, "00000000-0000-4000-8000-000000000008");
  const delays: number[] = [];
  const connection = createConnection({
    ompAcpDirectory: store.dir,
    ompUsageMode: "off",
    ompUsageRetry: async (delayMs: number) => {
      delays.push(delayMs);
      insertStep(file, 7, { input: 30, output: 3, cachedWrite: 0, cachedRead: 0, thought: 0 });
    },
  });
  try {
    const batch = await connection.readModelUsageBatch(file, 0);
    assert.deepEqual(delays, [15], "the first retry must find the commit");
    assert.equal(batch?.calls, 1);
    assert.equal(batch?.maxIdx, 7);
  } finally {
    await connection.close();
    await store.cleanup();
  }
});

test("the WAL retry window is bounded and stops on abort", async () => {
  const store = await temporaryStore();
  const file = createStore(store.dir, "00000000-0000-4000-8000-000000000009");
  const delays: number[] = [];
  const connection = createConnection({
    ompAcpDirectory: store.dir,
    ompUsageMode: "off",
    ompUsageRetry: async (delayMs: number) => { delays.push(delayMs); },
  });
  try {
    assert.equal(await connection.readModelUsageBatch(file, 0), undefined);
    assert.deepEqual(delays, [15, 35], "the window must stay at two short attempts");

    const controller = new AbortController();
    const aborted: number[] = [];
    const cancelling = createConnection({
      ompAcpDirectory: store.dir,
      ompUsageMode: "off",
      ompUsageRetry: async (delayMs: number) => { aborted.push(delayMs); controller.abort(); },
    });
    try {
      assert.equal(await cancelling.readModelUsageBatch(file, 0, controller.signal), undefined);
      assert.deepEqual(aborted, [15], "an aborted turn must not keep retrying");
    } finally {
      await cancelling.close();
    }
  } finally {
    await connection.close();
    await store.cleanup();
  }
});

test("the default retry scheduler stays inside the fake timer window", async (context) => {
  const store = await temporaryStore();
  const file = createStore(store.dir, "00000000-0000-4000-8000-00000000000a");
  const connection = createConnection({ ompAcpDirectory: store.dir, ompUsageMode: "off" });
  try {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = connection.readModelUsageBatch(file, 0);
    context.mock.timers.tick(15);
    await tick();
    context.mock.timers.tick(35);
    await tick();
    assert.equal(await pending, undefined);
  } finally {
    context.mock.timers.reset();
    await connection.close();
    await store.cleanup();
  }
});

test("the session store directory comes from the injected value, the cleanup lease, or the environment", async () => {
  const store = await temporaryStore();
  const cleanup = {
    acpDir: store.dir,
    start: () => {},
    touch: async () => {},
    acquire: async () => "lease",
    release: async () => {},
    retire: async () => {},
    confirm: async () => {},
  } as unknown as SessionCleanup;
  const injected = createConnection({ ompAcpDirectory: store.dir });
  const leased = createConnection({ ompCleanup: cleanup });
  const fallback = createConnection();
  try {
    assert.equal(injected.acpDirectory, store.dir);
    assert.equal(leased.acpDirectory, store.dir);
    assert.equal(fallback.acpDirectory, resolveAntigravityAcpDirectory());
  } finally {
    await injected.close();
    await leased.close();
    await fallback.close();
    await store.cleanup();
  }
});
