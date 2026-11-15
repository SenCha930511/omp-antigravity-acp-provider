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
}

async function fixture(options: FixtureOptions) {
  const connections: any[] = [];
  const runtime = new AntigravityRuntime((connectionOptions: any) => {
    const exit = Promise.withResolvers<any>();
    const process = { alive: true, exited: exit.promise };
    let id = randomUUID();
    const connection: any = {
      process,
      async initialize() {
        return { protocolVersion: 1, agentCapabilities: { promptCapabilities: { embeddedContext: true } } };
      },
      async newSession() { id = randomUUID(); return { sessionId: id, modes, models }; },
      getSessionState() { return { modes, models }; },
      consumeNoticeCapture() { return options.capture?.(); },
      async prompt(request: any) {
        return options.prompt({ ...connection, request }, connectionOptions.handlers);
      },
      async close() { if (!process.alive) return; process.alive = false; exit.resolve({ code: 0 }); },
    };
    connections.push(connection);
    return connection;
  }, "yolo");
  async function turn(sessionId: string, parentSessionId?: string) {
    const events: any[] = [];
    for await (const event of runtime.stream(model as any, {
      tools: [],
      messages: [{ role: "user", content: "KEEP_WORKING", timestamp: 1 }],
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
