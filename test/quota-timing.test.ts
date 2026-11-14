import assert from "node:assert/strict";
import test from "node:test";
import type { PromptRequest, SessionNotification } from "@agentclientprotocol/sdk";
import { AntigravityRuntime } from "../extension/runtime/runtime.ts";
import { abortError } from "../extension/runtime/acp/errors.ts";
import type { TierConnection } from "../extension/tier-connection.ts";

const quotaBody = [
  "### Quota Limits",
  "- **Gemini Models**",
  "  - **weekly:** 96% remaining (resets Nov 14, 2026, 13:50 UTC)",
].join("\n");

interface Probe {
  order: string[];
  waits: number[];
  blocked: boolean;
  promptStarted: Promise<void>;
  waitStarted: Promise<void>;
  graceCalls: number[];
  graceStarted: Promise<void>;
  markGraceStarted: () => void;
  markPromptStarted: () => void;
  markWaitStarted: () => void;
  resolveGrace?: () => void;
  closed: Promise<void>;
  markClosed: () => void;
}

type UpdateHandler = NonNullable<ConstructorParameters<typeof TierConnection>[0]["handlers"]>["onUpdate"];

class FixtureConnection {
  private readonly exited = Promise.withResolvers<void>();
  readonly process = { alive: true, pid: 4242, exited: this.exited.promise };
  activePrompts = 0;

  constructor(private readonly probe: Probe, private readonly reporter: UpdateHandler | undefined) {}

  async initialize() {
    return {
      protocolVersion: 1,
      authMethods: [{ id: "api-key", name: "Gemini API key", _meta: { "api-key": {} } }],
      agentCapabilities: {},
    };
  }

  async authenticate() {}

  async newSession() {
    this.probe.order.push("new-session");
    return {
      sessionId: "quota-timing-fixture",
      models: {
        currentModelId: "gemini-3.8-flash",
        availableModels: [{ modelId: "gemini-3.8-flash", name: "Flash" }],
      },
    };
  }

  async setModel() {
    this.probe.order.push("set-model");
  }

  async waitForUsageCommand(_sessionId: string, timeoutMs = 5_000, signal?: AbortSignal): Promise<boolean> {
    this.probe.waits.push(timeoutMs);
    this.probe.order.push("wait");
    this.probe.markWaitStarted();
    if (!this.probe.blocked) return true;
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const settle = () => resolve(false);
    signal?.addEventListener("abort", settle, { once: true });
    if (signal?.aborted) settle();
    return promise;
  }

  async promptWithoutUsageDeltas(request: PromptRequest): Promise<{ stopReason: "end_turn" }> {
    this.probe.order.push("prompt");
    this.probe.markPromptStarted();
    const notification: SessionNotification = {
      sessionId: request.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: quotaBody } },
    };
    await this.reporter?.(notification);
    return { stopReason: "end_turn" };
  }

  async discardSession() {
    this.probe.order.push("discard");
  }

  async close() {
    this.probe.order.push("close");
    this.probe.markClosed();
    this.process.alive = false;
    this.exited.resolve();
  }
}

function harness(blocked = false) {
  const promptStarted = Promise.withResolvers<void>();
  const waitStarted = Promise.withResolvers<void>();
  const graceStarted = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const probe: Probe = {
    order: [], waits: [], blocked, graceCalls: [],
    promptStarted: promptStarted.promise,
    waitStarted: waitStarted.promise,
    graceStarted: graceStarted.promise,
    markGraceStarted: graceStarted.resolve,
    markPromptStarted: promptStarted.resolve,
    markWaitStarted: waitStarted.resolve,
    closed: closed.promise,
    markClosed: closed.resolve,
  };
  const runtime = new AntigravityRuntime(options => {
    probe.order.push("factory-options");
    return new FixtureConnection(probe, options.handlers?.onUpdate) as unknown as TierConnection;
  }, "default", undefined, undefined, 1_500, (signal, delayMs) => {
    probe.markGraceStarted();
    probe.order.push(`grace:${delayMs}`);
    probe.graceCalls.push(delayMs);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    probe.resolveGrace = resolve;
    const cancelled = () => reject(abortError());
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    return promise.finally(() => signal.removeEventListener("abort", cancelled));
  });
  return { runtime, probe };
}

test("quota waits 20 seconds and closes only after refresh completes", async () => {
  const { runtime, probe } = harness();
  try {
    const pending = runtime.quota("offline-fixture-key");
    await probe.graceStarted;
    assert.deepEqual(probe.waits, [20_000]);
    assert.deepEqual(probe.graceCalls, [1_500]);
    assert.equal(probe.order.includes("close"), false);
    const complete = probe.resolveGrace;
    assert.ok(complete, "quota must enter the refresh scheduler");
    complete();
    const snapshot = await pending;
    assert.equal(snapshot.groups[0]?.buckets[0]?.remainingFraction, 0.96);
    assert.deepEqual(probe.order, [
      "factory-options", "new-session", "set-model", "wait", "prompt", "discard", "grace:1500", "close",
    ]);
  } finally {
    await runtime.close();
  }
});

test("abort during advertisement wait closes without a refresh grace", async () => {
  const { runtime, probe } = harness(true);
  const controller = new AbortController();
  try {
    const pending = runtime.quota("offline-fixture-key", controller.signal);
    await probe.waitStarted;
    controller.abort("explicit probe cancellation");
    await assert.rejects(pending, /abort|cancel/iu);
    assert.deepEqual(probe.waits, [20_000]);
    assert.deepEqual(probe.graceCalls, []);
    assert.deepEqual(probe.order, ["factory-options", "new-session", "set-model", "wait", "discard", "close"]);
  } finally {
    await runtime.close();
  }
});

test("abort during refresh completes cancellation and still closes", async () => {
  const { runtime, probe } = harness();
  const controller = new AbortController();
  try {
    const pending = runtime.quota("offline-fixture-key", controller.signal);
    await probe.graceStarted;
    controller.abort("cancel during refresh finish");
    await Promise.all([assert.rejects(pending, /abort|cancel/iu), probe.closed]);
    assert.deepEqual(probe.graceCalls, [1_500]);
    assert.deepEqual(probe.order.slice(-3), ["discard", "grace:1500", "close"]);
  } finally {
    await runtime.close();
  }
});
