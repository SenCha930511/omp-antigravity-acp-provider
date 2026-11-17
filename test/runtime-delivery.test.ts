// Relay delivery ordering regressions. A batch is decided before the prompt so
// the envelope can be sent with it; it may only be marked delivered once that
// turn actually consumed it. A dispatch that throws, a quota classification or
// a cancelled turn must leave the obligations open for the next turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import { AntigravityRuntime, authenticateForCredential } from "../extension/runtime.mjs";
import { hasUndeliveredRelay } from "../extension/runtime/tools/delivery.ts";

const model = { id: "gemini-3.8-flash", name: "Flash", api: "antigravity-acp-provider", provider: "antigravity-acp-provider",
  contextWindow: 524288, maxTokens: 32000, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const modes = { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] };
const models = { currentModelId: model.id, availableModels: [{ modelId: model.id, name: "Flash" }] };
const user = (content: string) => ({ role: "user", content, timestamp: 1 });
const QUOTA_NOTICE = "Usage Limit Reached\n\nYou have reached your current quota for this period. " +
  "Your limit will reset on Nov 12, 2026 01:02 UTC.";

type Action = "answer" | "quota-notice" | "throw-quota" | "throw" | "abort" | "refusal";
type Capture = { terminal?: string; apiDetail?: string; refusedDetail?: string };

// The runtime only keeps a binding warm across a quota failure, and its quota
// branch tests `instanceof AntigravityAcpError`. Take that exact class from the
// runtime bundle and label it as a quota failure.
async function bundleQuotaError(): Promise<Error> {
  try {
    await authenticateForCredential({} as never, { protocolVersion: 1 } as never, "fixture-api-key");
  } catch (error) {
    Object.defineProperty(error as object, "code", { value: "quota", configurable: true, enumerable: true, writable: true });
    return error as Error;
  }
  throw new Error("the fixture expected authenticateForCredential to reject");
}

function fixture() {
  const connections: any[] = [];
  const actions: Action[] = [];
  let capture: Capture | undefined;
  const runtime: any = new AntigravityRuntime((options: any) => {
    const exit = Promise.withResolvers<any>();
    const connection: any = {
      id: undefined as string | undefined,
      prompts: [] as any[],
      process: { alive: true, exited: exit.promise },
      async initialize() {
        return { protocolVersion: 1, agentCapabilities: { promptCapabilities: { embeddedContext: true } } };
      },
      async newSession() { connection.id = randomUUID(); return { sessionId: connection.id, modes, models }; },
      getSessionState() { return { modes, models }; },
      consumeNoticeCapture() { const value = capture; capture = undefined; return value; },
      async prompt(request: any, signal?: AbortSignal) {
        connection.prompts.push(structuredClone(request));
        const action = actions.shift() ?? "answer";
        if (action === "throw-quota") throw await bundleQuotaError();
        if (action === "throw") throw new Error("dispatch failed");
        if (action === "abort") {
          signal?.abort();
          throw new DOMException("Aborted", "AbortError");
        }
        if (action === "quota-notice") return { stopReason: "end_turn" };
        if (action === "refusal") return { stopReason: "refusal" };
        options.handlers.onUpdate({ sessionId: connection.id,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ANSWER" } } });
        return { stopReason: "end_turn" };
      },
      async close() {
        if (!connection.process.alive) return;
        connection.process.alive = false;
        exit.resolve({ code: 0 });
      },
    };
    connections.push(connection);
    return connection;
  }, "yolo", undefined, 10);
  async function run(messages: any[], sessionId = "delivery", signal?: AbortSignal) {
    const events: any[] = [];
    for await (const event of runtime.stream(model, { messages, tools: [] }, { sessionId, signal }).stream) {
      events.push(structuredClone(event));
    }
    await tick();
    return {
      error: events.find(event => event.type === "error")?.error?.errorMessage as string | undefined,
      message: events.find(event => event.type === "done")?.message,
    };
  }
  const binding = (sessionId = "delivery") =>
    [...runtime.resolvedBindings].find((candidate: any) => candidate.key === `sid:${sessionId}`);
  return {
    runtime, connections, actions, run, binding,
    setCapture(value: Capture | undefined) { capture = value; },
    async close() { await runtime.close(); },
  };
}

// A settled relay record plus an observed notice is exactly the state that makes
// the next dispatch carry a bounded <tool_result> envelope.
async function seedSettledRelay(binding: any, callId: string): Promise<void> {
  const result = { content: [{ type: "text", text: "RESULT_ONE" }], isError: false };
  await binding.relay.call({ id: callId, name: "read", arguments: { path: "/fixture" } }, async () => result);
  binding.delivery.observe({ id: callId, name: "read", arguments: { path: "/fixture" } }, callId);
  assert.deepEqual(binding.delivery.open(), [callId], "the fixture must start with one open obligation");
}

const promptText = (connection: any) => JSON.stringify(connection.prompts.at(-1));

test("a prompt throw after a decided batch leaves the relay obligation open", async () => {
  const f = fixture();
  try {
    const first = await f.run([user("FIRST_ASK")]);
    assert.ok(first.message, "the fixture must complete a first turn");
    const binding = f.binding();
    assert.ok(binding);
    await seedSettledRelay(binding, "call-1");

    f.actions.push("throw-quota");
    const failed = await f.run([user("FIRST_ASK"), first.message, user("NEXT_ASK")]);
    assert.ok(failed.error, "the failed dispatch must surface as an error");
    assert.match(failed.error, /quota exceeded/);
    assert.match(promptText(f.connections[0]), /<tool_result/,
      "the batch must be decided before the prompt so the envelope is actually sent");
    assert.deepEqual(binding.delivery.open(), ["call-1"],
      "a prompt that threw must not deliver the batch");
    assert.equal(hasUndeliveredRelay(binding.delivery, ["call-1"]), true);
  } finally {
    await f.close();
  }
});

test("a quota notice after a decided batch leaves the relay obligation open", async () => {
  const f = fixture();
  try {
    const first = await f.run([user("FIRST_ASK")]);
    assert.ok(first.message);
    const binding = f.binding();
    await seedSettledRelay(binding, "call-1");

    f.actions.push("quota-notice");
    f.setCapture({ apiDetail: QUOTA_NOTICE });
    const failed = await f.run([user("FIRST_ASK"), first.message, user("NEXT_ASK")]);
    assert.ok(failed.error, "quota exhaustion must fail the turn");
    assert.match(failed.error, /quota exceeded/);
    assert.match(promptText(f.connections[0]), /<tool_result/);
    assert.deepEqual(binding.delivery.open(), ["call-1"],
      "a quota classification must run before the batch is committed");
  } finally {
    await f.close();
  }
});

test("a completed turn commits the decided batch", async () => {
  const f = fixture();
  try {
    const first = await f.run([user("FIRST_ASK")]);
    assert.ok(first.message);
    const binding = f.binding();
    await seedSettledRelay(binding, "call-1");

    const next = await f.run([user("FIRST_ASK"), first.message, user("NEXT_ASK")]);
    assert.equal(next.error, undefined, `the warm turn must succeed, got ${next.error}`);
    assert.match(promptText(f.connections[0]), /<tool_result/);
    assert.deepEqual(binding.delivery.open(), [], "only a completed turn delivers the batch");
  } finally {
    await f.close();
  }
});

test("a non-quota prompt failure hands the settled batch to the replacement binding", async () => {
  const f = fixture();
  try {
    const first = await f.run([user("FIRST_ASK")]);
    assert.ok(first.message);
    const firstBinding = f.binding();
    assert.ok(firstBinding);
    await seedSettledRelay(firstBinding, "call-1");

    f.actions.push("throw");
    const failed = await f.run([user("FIRST_ASK"), first.message, user("NEXT_ASK")]);
    assert.ok(failed.error);
    assert.match(failed.error, /dispatch failed/);
    const next = await f.run([user("FIRST_ASK"), first.message, user("NEXT_ASK")]);
    assert.equal(f.connections.length, 2, "the failed binding must be replaced");
    assert.equal(next.error, undefined, `the replacement binding must deliver the result, got ${next.error}`);
    assert.match(promptText(f.connections[1]), /<tool_result/,
      "the settled result must be adopted by the replacement binding");
    assert.deepEqual(f.binding().delivery.open(), [], "only a completed replacement turn delivers it");
  } finally {
    await f.close();
  }
});

test("cancellation preserves a settled batch for the next turn", async () => {
  const f = fixture();
  try {
    const first = await f.run([user("FIRST_ASK")]);
    assert.ok(first.message);
    const binding = f.binding();
    assert.ok(binding);
    await seedSettledRelay(binding, "call-1");

    f.actions.push("abort");
    const controller = new AbortController();
    await f.run([user("FIRST_ASK"), first.message, user("NEXT_ASK")], "delivery", controller.signal);

    const next = await f.run([user("FIRST_ASK"), first.message, user("NEXT_ASK")]);
    assert.equal(next.error, undefined, `the cancelled batch must be retried, got ${next.error}`);
    assert.match(promptText(f.connections.at(-1)), /<tool_result/,
      "cancellation must not erase the settled result");
    assert.deepEqual(f.binding().delivery.open(), [], "the retried turn delivers it");
  } finally {
    await f.close();
  }
});

test("a refusal leaves the settled batch open for the next turn", async () => {
  const f = fixture();
  try {
    const first = await f.run([user("FIRST_ASK")]);
    assert.ok(first.message);
    const binding = f.binding();
    assert.ok(binding);
    await seedSettledRelay(binding, "call-1");

    f.actions.push("refusal");
    const refused = await f.run([user("FIRST_ASK"), first.message, user("NEXT_ASK")]);
    assert.ok(refused.error);
    assert.match(refused.error, /refus/i);

    const next = await f.run([user("FIRST_ASK"), first.message, user("NEXT_ASK")]);
    assert.equal(next.error, undefined, `the refused batch must be retried, got ${next.error}`);
    assert.match(promptText(f.connections.at(-1)), /<tool_result/,
      "a refusal must not commit the batch");
    assert.deepEqual(f.binding().delivery.open(), [], "the retried turn delivers it");
  } finally {
    await f.close();
  }
});

test("a rewind discards a retained batch from an earlier failed turn", async () => {
  const f = fixture();
  try {
    const first = await f.run([user("FIRST_ASK")]);
    assert.ok(first.message);
    const binding = f.binding();
    assert.ok(binding);
    await seedSettledRelay(binding, "call-1");

    f.actions.push("throw");
    const failed = await f.run([user("FIRST_ASK"), first.message, user("NEXT_ASK")]);
    assert.ok(failed.error);

    // The retained batch belongs to the three-message context. A shorter
    // context is a rewind and must not resurrect the old tool result.
    const rewound = await f.run([user("FIRST_ASK")]);
    assert.equal(rewound.error, undefined, `the rewound turn must succeed, got ${rewound.error}`);
    assert.doesNotMatch(promptText(f.connections.at(-1)), /<tool_result/,
      "a rewound conversation must not receive the old envelope");
  } finally {
    await f.close();
  }
});
