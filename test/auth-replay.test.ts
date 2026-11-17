import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AntigravityRuntime } from "../extension/runtime.mjs";

const model = { id: "gemini-3.8-flash", name: "Flash", api: "antigravity-acp", provider: "antigravity-acp",
  contextWindow: 524288, maxTokens: 32000, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const modes = { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] };
const models = { currentModelId: model.id, availableModels: [{ modelId: model.id, name: "Flash" }] };
const AUTH_EXPIRED = new Error("Antigravity ACP error: authentication required (401 unauthenticated, token expired)");

interface FixtureOptions {
  prompt: (connection: any, handlers: { onUpdate: (n: unknown) => void }) => Promise<unknown>;
  capture?: () => { terminal?: string; apiDetail?: string; refusedDetail?: string } | undefined;
  routing?: { nativeTools: "prefer" | "disabled"; channel: "pending" | "system-append" | "legacy-prompt" };
  onConnection?: (count: number) => void;
}

async function fixture(options: FixtureOptions) {
  const connections: any[] = [];
  const runtime = new AntigravityRuntime((connectionOptions: any) => {
    const exit = Promise.withResolvers<any>();
    const process = { alive: true, exited: exit.promise };
    let id = randomUUID();
    const connection: any = {
      prompts: [] as any[],
      process,
      ...(options.routing ? { toolRouting: { ...options.routing } } : {}),
      async initialize() {
        return { protocolVersion: 1, agentCapabilities: { promptCapabilities: { embeddedContext: true } } };
      },
      async newSession() { id = randomUUID(); return { sessionId: id, modes, models }; },
      getSessionState() { return { modes, models }; },
      consumeNoticeCapture() { return options.capture?.(); },
      async prompt(request: any) {
        connection.prompts.push(structuredClone(request));
        return options.prompt({ ...connection, request }, connectionOptions.handlers);
      },
      async close() { if (!process.alive) return; process.alive = false; exit.resolve({ code: 0 }); },
    };
    connections.push(connection);
    options.onConnection?.(connections.length);
    return connection;
  }, "yolo");
  async function turn(
    sessionId: string,
    parentSessionId?: string,
    messages: any[] = [{ role: "user", content: "KEEP_WORKING", timestamp: 1 }],
    systemPrompt?: string,
  ) {
    const events: any[] = [];
    for await (const event of runtime.stream(model as any, {
      tools: [],
      messages,
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
    }, { sessionId, ...(parentSessionId ? { parentSessionId } : {}) }).stream) {
      events.push(structuredClone(event));
    }
    return {
      error: events.find((event) => event.type === "error")?.error?.errorMessage,
      message: events.find((event) => event.type === "done")?.message,
    };
  }
  return { runtime, connections, turn };
}

test("an auth expiry mid-turn replays once on a fresh process", async () => {
  const { runtime, connections, turn } = await fixture({
    prompt: async (connection, handlers) => {
      if (connections.length === 1) throw AUTH_EXPIRED;
      handlers.onUpdate({ sessionId: connection.request.sessionId, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "RECOVERED" } } });
      return { stopReason: "end_turn" };
    },
  });
  try {
    const result = await turn("auth-replay");
    assert.equal(result.error, undefined, `the replayed turn must succeed, got ${result.error}`);
    assert.match(result.message.content[0].text, /RECOVERED/);
    assert.equal(connections.length, 2, "the expired process must be replaced exactly once");
  } finally {
    await runtime.close();
  }
});

test("late chunks from the expired auth attempt do not reach the replay writer", async () => {
  const secondReady = Promise.withResolvers<void>();
  const lateDone = Promise.withResolvers<void>();
  let attempts = 0;
  const { runtime, connections, turn } = await fixture({
    onConnection: count => { if (count === 2) secondReady.resolve(); },
    prompt: async (connection, handlers) => {
      attempts++;
      if (attempts === 1) {
        void secondReady.promise.then(() => {
          handlers.onUpdate({ sessionId: connection.request.sessionId, update: {
            sessionUpdate: "agent_message_chunk", content: { type: "text", text: "STALE" } } });
          lateDone.resolve();
        });
        throw AUTH_EXPIRED;
      }
      await lateDone.promise;
      handlers.onUpdate({ sessionId: connection.request.sessionId, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "RECOVERED" } } });
      return { stopReason: "end_turn" };
    },
  });
  try {
    const result = await turn("auth-replay-late");
    assert.equal(attempts, 2, "the auth expiry must replay exactly once");
    assert.equal(connections.length, 2, "the expired process must be replaced");
    assert.match(result.message.content[0].text, /RECOVERED/);
    assert.doesNotMatch(result.message.content[0].text, /STALE/,
      "late output from the expired connection must not reach the reused writer");
  } finally {
    await runtime.close();
  }
});

test("a persistently expired session fails after exactly one replay", async () => {
  const { runtime, connections, turn } = await fixture({
    prompt: async () => { throw AUTH_EXPIRED; },
  });
  try {
    const result = await turn("auth-replay-stuck");
    assert.ok(result.error, "the second auth failure must surface");
    assert.match(result.error, /sign in|auth/i);
    assert.equal(connections.length, 2, "the replay must not loop");
  } finally {
    await runtime.close();
  }
});

test("an empty turn with captured failure evidence becomes an error", async () => {
  const { runtime, turn } = await fixture({
    prompt: async () => ({ stopReason: "end_turn" }),
    capture: () => ({
      terminal: "⚠ Agent execution terminated due to error.",
      apiDetail: "⚠ RESOURCE_EXHAUSTED (code 429): Resource has been exhausted",
      refusedDetail: "⚠ RESOURCE_EXHAUSTED (code 429): Resource has been exhausted",
    }),
  });
  try {
    const result = await turn("notice-failure");
    assert.ok(result.error, "a banner-only empty turn must fail, not stream silence");
    assert.match(result.error, /exhausted|quota/i);
    assert.equal(result.message, undefined);
  } finally {
    await runtime.close();
  }
});

test("an empty turn without failure evidence stays a normal empty reply", async () => {
  const { runtime, turn } = await fixture({
    prompt: async () => ({ stopReason: "end_turn" }),
  });
  try {
    const result = await turn("notice-silent");
    assert.equal(result.error, undefined);
    assert.ok(result.message, "model silence without a banner is still a finished message");
  } finally {
    await runtime.close();
  }
});

test("a banner-only empty shadow turn becomes an error", async () => {
  const { runtime, turn } = await fixture({
    prompt: async () => ({ stopReason: "end_turn" }),
    capture: () => ({ terminal: "\u26a0 Agent execution terminated due to error." }),
  });
  try {
    const result = await turn("auth-replay-shadow:side:conversation:btw:a:0", "auth-replay-shadow");
    assert.ok(result.error, "a banner-only empty side reply must fail, not stream silence");
    assert.match(result.error, /error banner/);
    assert.equal(result.message, undefined);
  } finally {
    await runtime.close();
  }
});

test("an auth expiry on a shadow turn replays once on a fresh process", async () => {
  const { runtime, connections, turn } = await fixture({
    prompt: async (connection, handlers) => {
      if (connections.length === 1) throw AUTH_EXPIRED;
      handlers.onUpdate({ sessionId: connection.request.sessionId, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "SIDE_RECOVERED" } } });
      return { stopReason: "end_turn" };
    },
  });
  try {
    const result = await turn("shadow-auth:side:conversation:btw:a:0", "shadow-auth");
    assert.equal(result.error, undefined, `the replayed side turn must succeed, got ${result.error}`);
    assert.match(result.message.content[0].text, /SIDE_RECOVERED/);
    assert.equal(connections.length, 2, "the expired side process must be replaced exactly once");
  } finally {
    await runtime.close();
  }
});

test("a prefer-mode fingerprint explains an empty 429 banner as a prompt rejection", async () => {
  const { runtime, turn } = await fixture({
    prompt: async () => ({ stopReason: "end_turn" }),
    capture: () => ({ apiDetail: "⚠ RESOURCE_EXHAUSTED (code 429): Resource has been exhausted" }),
    routing: { nativeTools: "prefer", channel: "system-append" },
  });
  try {
    const result = await turn("fingerprint-prefer", undefined, undefined, "Reply with exactly: OK");
    assert.ok(result.error, "an empty 429 banner must fail the turn");
    assert.match(result.error, /despite remaining quota/);
    assert.doesNotMatch(result.error, /quota exceeded/);
  } finally {
    await runtime.close();
  }
});

test("disabled-mode cloaked instructions keep an empty 429 banner a quota failure", async () => {
  const { runtime, turn } = await fixture({
    prompt: async () => ({ stopReason: "end_turn" }),
    capture: () => ({ apiDetail: "⚠ RESOURCE_EXHAUSTED (code 429): Resource has been exhausted" }),
    routing: { nativeTools: "disabled", channel: "system-append" },
  });
  try {
    const result = await turn("fingerprint-disabled", undefined, undefined, "Reply with exactly: OK");
    assert.ok(result.error, "an empty 429 banner must fail the turn");
    assert.match(result.error, /quota exceeded/);
    assert.doesNotMatch(result.error, /fingerprint/);
  } finally {
    await runtime.close();
  }
});

const BIG = "x".repeat(75_000);
const assistantTurn = (text: string, timestamp: number) => ({
  role: "assistant", content: [{ type: "text", text }], provider: "antigravity-acp", model: model.id, timestamp,
});
const seededHistory = [
  { role: "user", content: "SEED_ONE_" + BIG, timestamp: 1 },
  assistantTurn("SEED_TWO_" + BIG, 2),
  { role: "user", content: "SEED_THREE_" + BIG, timestamp: 3 },
  assistantTurn("SEED_FOUR_" + BIG, 4),
  { role: "user", content: "FINAL_ASK", timestamp: 5 },
];
const seedStepPrompts = (connection: any) =>
  connection.prompts.filter((request: any) => JSON.stringify(request).includes("Reply only with: OK"));

test("a transient API retry capture does not fail a seed step that acknowledged OK", async () => {
  const { runtime, connections, turn } = await fixture({
    prompt: async (connection, handlers) => {
      const seed = JSON.stringify(connection.request).includes("Reply only with: OK");
      handlers.onUpdate({ sessionId: connection.request.sessionId, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: seed ? "OK" : "FINAL_ANSWER" } } });
      return { stopReason: "end_turn" };
    },
    capture: () => ({ apiDetail: "⚠ API error (attempt 1): upstream reset" }),
  });
  try {
    const result = await turn("seed-transient", undefined, seededHistory);
    assert.equal(result.error, undefined, `a retried seed step must not fail the turn, got ${result.error}`);
    assert.match(result.message.content[0].text, /FINAL_ANSWER/);
    assert.ok(seedStepPrompts(connections[0]).length > 0, "the fixture must actually dispatch hidden seed steps");
  } finally {
    await runtime.close();
  }
});

test("a transient API retry capture does not fail a shadow seed step that acknowledged OK", async () => {
  const { runtime, connections, turn } = await fixture({
    prompt: async (connection, handlers) => {
      const seed = JSON.stringify(connection.request).includes("Reply only with: OK");
      handlers.onUpdate({ sessionId: connection.request.sessionId, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: seed ? "OK" : "SIDE_ANSWER" } } });
      return { stopReason: "end_turn" };
    },
    capture: () => ({ apiDetail: "⚠ API error (attempt 1): upstream reset" }),
  });
  const side = [
    ...seededHistory.slice(0, 4),
    { role: "developer", content: "Ephemeral side-channel turn.", timestamp: 9 },
    { role: "user", content: "<btw>\nSIDE_QUESTION\n</btw>", timestamp: 10 },
  ];
  try {
    const result = await turn("shadow-seed:side:conversation:btw:a:0", "shadow-seed", side);
    assert.equal(result.error, undefined, `a retried shadow seed step must not fail the turn, got ${result.error}`);
    assert.match(result.message.content[0].text, /SIDE_ANSWER/);
    assert.ok(seedStepPrompts(connections[0]).length > 0, "the fixture must actually dispatch hidden side seed steps");
  } finally {
    await runtime.close();
  }
});
