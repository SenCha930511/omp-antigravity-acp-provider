// Standby warmup lifecycle. Every connection here is a fake: no ACP process,
// no credential store and no model request is ever touched.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { registerOmpAdapter } from "../extension/index.ts";
import { keychain, secretService } from "../extension/auth-sync.ts";
import type { TierConnection } from "../extension/runtime.mjs";

const MODEL_ID = "gemini-3.8-flash";
const QUOTA_TEXT = [
  "### Quota Limits",
  "- **Gemini Models**",
  "  - **weekly:** 96% remaining (resets Nov 14, 2026, 13:50 UTC)",
].join("\n");

async function settle(context: TestContext): Promise<void> {
  for (let iteration = 0; iteration < 8; iteration++) {
    context.mock.timers.tick(2_000);
    await Promise.resolve();
  }
}

async function waitFor(context: TestContext, predicate: () => boolean, label: string): Promise<void> {
  for (let iteration = 0; iteration < 64; iteration++) {
    if (predicate()) return;
    await settle(context);
  }
  throw new Error(`no progress waiting for ${label}`);
}

async function driveToSettlement(context: TestContext, pending: Promise<unknown>, label: string): Promise<void> {
  let state: "pending" | "fulfilled" | "rejected" = "pending";
  void pending.then(
    () => { state = "fulfilled"; },
    () => { state = "rejected"; },
  );
  for (let iteration = 0; iteration < 128; iteration++) {
    await Promise.resolve();
    if (state === "fulfilled") return;
    if (state === "rejected") {
      await pending;
      return;
    }
    context.mock.timers.tick(2_000);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`no settlement for ${label} after bounded fake-clock advance`);
}

interface FakeHandlers {
  onUpdate?: (notification: unknown) => unknown;
  onPermission?: (request: unknown) => unknown;
}

type FakeOptions = Record<string, unknown> & { handlers?: FakeHandlers; ompPurpose?: string; ompNativeTools?: string };

let sessionCounter = 0;
const fakeClockContexts = new WeakSet<TestContext>();

class FakeConnection {
  readonly options: FakeOptions;
  handlers: FakeHandlers | undefined;
  private readonly exited = Promise.withResolvers<void>();
  readonly closedPromise = Promise.withResolvers<void>();
  readonly process = { alive: true, pid: 4_242, generation: 1, exited: this.exited.promise };
  activePrompts = 0;
  initializeCalls = 0;
  newSessionCalls = 0;
  promptCalls = 0;
  closeCalls = 0;
  rebound = 0;
  closed = false;
  failInitialize = false;
  hangInitialize = false;
  sessionGate: Promise<void> | undefined;
  sessionId = `warmup-fixture-${++sessionCounter}`;
  currentModel = MODEL_ID;
  currentMode = "yolo";
  private readonly settled = Promise.withResolvers<void>();
  private abortInitialize?: () => void;

  constructor(options: FakeOptions) {
    this.options = options;
    this.handlers = options.handlers;
  }

  initialized(): Promise<void> {
    return this.settled.promise;
  }

  private state() {
    return {
      configOptions: [
        {
          id: "model", name: "Model", category: "model", type: "select", currentValue: this.currentModel,
          options: [{ value: MODEL_ID, name: "Gemini 3.8 Flash" }],
        },
        {
          id: "mode", name: "Mode", category: "mode", type: "select", currentValue: this.currentMode,
          options: [{ value: "yolo", name: "Yolo" }, { value: "default", name: "Default" }],
        },
      ],
    };
  }

  async initialize(signal?: AbortSignal) {
    this.initializeCalls += 1;
    if (this.failInitialize) {
      this.settled.resolve();
      throw new Error("synthetic initialize failure");
    }
    if (this.hangInitialize) {
      const pending = Promise.withResolvers<never>();
      const onAbort = () => pending.reject(new Error("synthetic initialize abort"));
      this.abortInitialize = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      try {
        await pending.promise;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (this.abortInitialize === onAbort) this.abortInitialize = undefined;
      }
    }
    this.settled.resolve();
    return { protocolVersion: 1, agentCapabilities: {} };
  }

  async newSession() {
    this.newSessionCalls += 1;
    await this.sessionGate;
    return { sessionId: this.sessionId, ...this.state() };
  }

  getSessionState() {
    return this.state();
  }

  async setModel(_sessionId: string, modelId: string) {
    this.currentModel = modelId;
  }

  async setMode(_sessionId: string, mode: string) {
    this.currentMode = mode;
  }

  async prompt(request: { sessionId: string }) {
    this.promptCalls += 1;
    this.handlers?.onUpdate?.({
      sessionId: request.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ANSWER" } },
    });
    return { stopReason: "end_turn" };
  }

  async waitForUsageCommand() {
    return true;
  }

  async promptWithoutUsageDeltas(request: { sessionId: string }) {
    this.handlers?.onUpdate?.({
      sessionId: request.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: QUOTA_TEXT } },
    });
    return { stopReason: "end_turn" };
  }

  // The adapter rebinds the OMP handlers in place instead of respawning.
  rebindHandlers(next: FakeHandlers | undefined) {
    this.handlers = next;
    this.rebound += 1;
  }

  async discardSession() {}
  async confirmReplacement() {}
  async retireForReplacement() {}
  setOmpContextWindow() {}
  setOmpSystemInstructions() {}
  setOmpSessionKind() {}
  muteSteerChunks() {}
  holdPromptWatchdog() { return () => {}; }
  takeCompactionNotices() { return []; }

  async close() {
    if (this.closed) return;
    this.closeCalls += 1;
    this.closed = true;
    this.process.alive = false;
    this.closedPromise.resolve();
    this.exited.resolve();
    const abort = this.abortInitialize;
    this.abortInitialize = undefined;
    abort?.();
  }
}

interface AdapterHandle {
  created: FakeConnection[];
  hooks: Map<string, (event: unknown, ctx: unknown) => unknown>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  provider: { models: Array<{ id: string }>; streamSimple: (model: unknown, context: unknown, options: unknown) => AsyncIterable<unknown>; usage?: { fetchUsage: (params: { signal?: AbortSignal }) => Promise<{ limits: unknown[] } | null> } };
  shutdown: () => Promise<unknown>;
  restore: () => Promise<void>;
}

async function startAdapter(context: TestContext, config: {
  seedCache?: boolean;
  isolateHome?: boolean;
  env?: Record<string, string | undefined>;
  configJson?: unknown;
  contextJson?: unknown;
  configure?: (connection: FakeConnection, index: number, created: FakeConnection[]) => void;
} = {}): Promise<AdapterHandle> {
  if (!fakeClockContexts.has(context)) {
    fakeClockContexts.add(context);
    context.mock.timers.enable({ apis: ["setTimeout"] });
  }
  context.after(() => { context.mock.timers.reset(); });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-warmup-"));
  const state = path.join(root, "state");
  const geminiHome = path.join(root, "gemini");
  const home = path.join(root, "home");
  const cli = path.join(root, "agy-fixture");
  await fs.mkdir(state, { recursive: true });
  await fs.mkdir(geminiHome, { recursive: true });
  if (config.isolateHome) await fs.mkdir(home, { recursive: true });
  await fs.writeFile(cli, "#!/bin/sh\nexit 0\n");
  await fs.chmod(cli, 0o755);
  if (config.seedCache !== false) {
    await fs.writeFile(path.join(state, "models-cache.json"), JSON.stringify({
      schemaVersion: 2,
      models: [{ modelId: MODEL_ID, name: "Gemini 3.8 Flash", selector: true }],
    }));
  }
  if (config.configJson !== undefined) {
    await fs.writeFile(path.join(state, "config.json"), JSON.stringify(config.configJson));
  }
  if (config.contextJson !== undefined) {
    await fs.writeFile(path.join(state, "context.json"), JSON.stringify(config.contextJson));
  }

  const previousEnv = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string | undefined) => {
    if (!previousEnv.has(key)) previousEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  const previousKeychain = keychain.present;
  const previousSecret = secretService.present;
  keychain.present = async () => false;
  secretService.present = async () => false;

  if (config.isolateHome) setEnv("HOME", home);
  setEnv("AGY_ACP_BIN", cli);
  setEnv("GEMINI_HOME", geminiHome);
  setEnv("GEMINI_API_KEY", "offline-fixture");
  setEnv("OMP_ACP_WARMUP", "on");
  for (const [key, value] of Object.entries(config.env ?? {})) setEnv(key, value);

  const created: FakeConnection[] = [];
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  let provider: AdapterHandle["provider"] | undefined;
  try {
    await registerOmpAdapter({
      on: (name, handler) => { hooks.set(name, handler as (event: unknown, ctx: unknown) => unknown); },
      registerTool() {},
      registerCommand: (name, command) => {
        commands.set(name, command as unknown as { handler: (args: string, ctx: unknown) => Promise<void> });
      },
      registerProvider: (_name, value) => { provider = value as AdapterHandle["provider"]; },
    }, state, (options: ConstructorParameters<typeof TierConnection>[0]) => {
      const connection = new FakeConnection(options as unknown as FakeOptions);
      const index = created.length;
      created.push(connection);
      config.configure?.(connection, index, created);
      return connection as unknown as TierConnection;
    }, { warmup: true });
  } catch (error) {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    keychain.present = previousKeychain;
    secretService.present = previousSecret;
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }

  const shutdown = async () => await hooks.get("session_shutdown")?.({}, {});
  let restored = false;
  return {
    created,
    hooks,
    commands,
    provider: provider!,
    shutdown,
    async restore() {
      if (restored) return;
      restored = true;
      try { await shutdown(); } catch { /* A fixture teardown must not mask the test result. */ }
      keychain.present = previousKeychain;
      secretService.present = previousSecret;
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

async function streamOnce(handle: AdapterHandle): Promise<Array<{ type: string }>> {
  const model = handle.provider.models[0];
  if (!model) throw new Error("fixture catalog did not expose a model");
  const events: Array<{ type: string }> = [];
  for await (const event of handle.provider.streamSimple(model,
    { messages: [{ role: "user", content: "synthetic", timestamp: 1 }], tools: [] }, {})) {
    events.push(event as { type: string });
  }
  return events;
}

async function warmStandby(context: TestContext, handle: AdapterHandle): Promise<FakeConnection> {
  handle.hooks.get("model_select")?.({ provider: "antigravity-acp" }, {});
  await waitFor(context, () => handle.created.length === 1, "the warmup connection");
  const warm = handle.created[0]!;
  await warm.initialized();
  await settle(context);
  return warm;
}

test("no warmup when the environment disables it or the value is unknown", async t => {
  for (const value of ["off", "sometimes"]) {
    const handle = await startAdapter(t, { env: { OMP_ACP_WARMUP: value } });
    try {
      handle.hooks.get("model_select")?.({ provider: "antigravity-acp" }, {});
      await settle(t);
      assert.equal(handle.created.length, 0, `OMP_ACP_WARMUP=${value} must not spawn`);
    } finally {
      await handle.restore();
    }
  }
});

test("another provider's same-named model never warms this adapter", async t => {
  const handle = await startAdapter(t);
  try {
    handle.hooks.get("model_select")?.({ provider: "google", modelId: MODEL_ID }, {});
    await settle(t);
    assert.equal(handle.created.length, 0, "another provider must never spawn an ACP process");
  } finally {
    await handle.restore();
  }
});

test("invalid context budgets do not block provider registration", async t => {
  const handle = await startAdapter(t, { contextJson: { defaults: { maxTokens: 999_999 } } });
  try {
    assert.ok(handle.provider.models.length > 0, "the offline catalog must still register");
  } finally {
    await handle.restore();
  }
});

test("no warmup without a usable provider target", async t => {
  // No env override, no CLI on PATH, and a "cli" preference: the launch plan
  // cannot name a target, so warmup must stay silent instead of spawning.
  const handle = await startAdapter(t, {
    isolateHome: true,
    env: { PATH: "", AGY_ACP_BIN: undefined },
    configJson: { runtimeSource: "cli" },
  });
  try {
    handle.hooks.get("model_select")?.({ provider: "antigravity-acp" }, {});
    await settle(t);
    assert.equal(handle.created.length, 0, "a plan without a target must not spawn");
  } finally {
    await handle.restore();
  }
});

test("no warmup when no local login is ready", async t => {
  const handle = await startAdapter(t, { env: { GEMINI_API_KEY: undefined } });
  try {
    handle.hooks.get("model_select")?.({ provider: "antigravity-acp" }, {});
    await settle(t);
    assert.equal(handle.created.length, 0, "an unauthenticated adapter must not spawn");
  } finally {
    await handle.restore();
  }
});

test("a successful initialize publishes the standby and the first binding reuses it", async t => {
  const handle = await startAdapter(t);
  try {
    const warm = await warmStandby(t, handle);
    assert.equal(warm.initializeCalls, 1);
    assert.equal(warm.newSessionCalls, 0, "warmup must never create a throwaway session");
    assert.equal(warm.rebound, 0);

    const events = await streamOnce(handle);
    assert.equal(handle.created.length, 1, "the standby must be reused instead of respawned");
    assert.equal(warm.rebound, 1, "the binding handlers are rebound on the warmed transport");
    assert.equal(warm.newSessionCalls, 1, "the binding creates its own session");
    assert.equal(warm.promptCalls, 1);
    assert.ok(events.some(event => event.type === "text_delta"), "the rebound handlers must carry the reply");
    assert.ok(!events.some(event => event.type === "error"), "the turn must not fail");
  } finally {
    await handle.restore();
  }
});

test("session_start warms only after the startup discovery connection closes", async t => {
  const liveAtCreation: number[] = [];
  const handle = await startAdapter(t, {
    seedCache: false,
    configure: (_connection, index, created) => {
      liveAtCreation[index] = created.slice(0, index).filter(connection => !connection.closed).length;
    },
  });
  try {
    await handle.hooks.get("session_start")?.({}, {});
    await waitFor(t, () => handle.created.length === 2, "discovery and then warmup");
    assert.equal(handle.created[0]!.newSessionCalls, 1, "discovery opens its own temporary session");
    assert.equal(handle.created[0]!.closed, true, "discovery closes before warmup starts");
    assert.equal(liveAtCreation[1], 0, "warmup must not overlap the discovery process");
    const warm = handle.created[1]!;
    await warm.initialized();
    await settle(t);
    assert.equal(warm.newSessionCalls, 0, "warmup never opens a session");
  } finally {
    await handle.restore();
  }
});

test("an initialize failure is ignored and the next turn spawns cold", async t => {
  const handle = await startAdapter(t, { configure: (connection, index) => { if (index === 0) connection.failInitialize = true; } });
  try {
    handle.hooks.get("model_select")?.({ provider: "antigravity-acp" }, {});
    await waitFor(t, () => handle.created.length === 1, "the warmup connection");
    const warm = handle.created[0]!;
    await waitFor(t, () => warm.closed, "the failed warmup connection to close");
    assert.equal(warm.newSessionCalls, 0);

    const events = await streamOnce(handle);
    assert.equal(handle.created.length, 2, "a failed standby leaves the cold path intact");
    assert.equal(handle.created[1]!.newSessionCalls, 1);
    assert.ok(events.some(event => event.type === "text_delta"));
    assert.ok(!events.some(event => event.type === "error"));
  } finally {
    await handle.restore();
  }
});

test("an aborted initialize is never published or handed to a turn", async t => {
  const handle = await startAdapter(t, { configure: (connection, index) => { if (index === 0) connection.hangInitialize = true; } });
  try {
    handle.hooks.get("model_select")?.({ provider: "antigravity-acp" }, {});
    await waitFor(t, () => handle.created.length === 1 && handle.created[0]!.initializeCalls === 1, "the hanging warmup");
    const warm = handle.created[0]!;

    const events = await streamOnce(handle);
    assert.equal(handle.created.length, 2, "a pending standby must not be hijacked by a turn");
    assert.equal(warm.rebound, 0);
    assert.equal(warm.newSessionCalls, 0);
    assert.ok(events.some(event => event.type === "text_delta"));

    await handle.shutdown();
    assert.equal(warm.closed, true, "shutdown must stop the in-flight warmup");
    assert.equal(warm.newSessionCalls, 0, "shutdown must never create a session");
  } finally {
    await handle.restore();
  }
});

test("a tool policy change evicts the standby instead of reusing it", async t => {
  const handle = await startAdapter(t);
  try {
    const warm = await warmStandby(t, handle);
    const command = handle.commands.get("antigravity-acp");
    if (!command) throw new Error("the adapter did not register its command");
    await command.handler("native-tools disabled", { ui: { notify() {} } });
    assert.equal(warm.closed, true, "a policy change must close the stale standby");

    const events = await streamOnce(handle);
    assert.equal(handle.created.length, 2);
    assert.equal(warm.rebound, 0, "the stale standby must never serve a turn");
    assert.equal(handle.created[1]!.options.ompNativeTools, "disabled");
    assert.ok(events.some(event => event.type === "text_delta"));
  } finally {
    await handle.restore();
  }
});

test("a permission change evicts the standby", async t => {
  const handle = await startAdapter(t);
  try {
    const warm = await warmStandby(t, handle);
    const command = handle.commands.get("antigravity-acp");
    if (!command) throw new Error("the adapter did not register its command");
    await command.handler("permissions yolo", { ui: { notify() {} } });
    assert.equal(warm.closed, true, "a permission change must close the stale standby");
  } finally {
    await handle.restore();
  }
});

test("quota discovery never consumes a standby", async t => {
  const handle = await startAdapter(t);
  try {
    const warm = await warmStandby(t, handle);
    const usage = handle.provider.usage;
    if (!usage) throw new Error("the provider did not register usage");
    const controller = new AbortController();
    t.after(() => controller.abort());
    const pending = usage.fetchUsage({ signal: controller.signal });
    await settle(t);
    await waitFor(t, () => handle.created.find(connection => connection.options.ompPurpose === "quota")?.closed === true,
      "the short-lived quota connection to finish its bounded grace and close");
    const report = await pending;
    assert.ok(report && report.limits.length > 0, "the fixture quota reply must parse");
    const quota = handle.created.find(connection => connection.options.ompPurpose === "quota");
    assert.ok(quota, "quota must run on its own connection");
    assert.notEqual(quota, warm);
    assert.equal(warm.rebound, 0, "quota must not take the standby handlers");
    assert.equal(warm.closed, false, "quota must leave the standby warm");

    const events = await streamOnce(handle);
    assert.equal(warm.rebound, 1, "the standby is still available to the next turn");
    assert.ok(events.some(event => event.type === "text_delta"));
  } finally {
    await handle.restore();
  }
});

test("logout waits for live discovery and quota connections before credential removal", async t => {
  for (const scenario of ["discovery", "quota"] as const) {
    const gate = Promise.withResolvers<void>();
    let source: Promise<unknown> | undefined;
    let logout: Promise<void> | undefined;
    const handle = await startAdapter(t, {
      seedCache: scenario === "quota",
      configure: connection => { connection.sessionGate = gate.promise; },
    });
    try {
      const command = handle.commands.get("antigravity-acp");
      if (!command) throw new Error("the adapter did not register its command");
      let direct: FakeConnection | undefined;
      if (scenario === "discovery") {
        const start = handle.hooks.get("session_start");
        if (!start) throw new Error("the adapter did not register session_start");
        source = Promise.resolve(start({}, {}));
        for (let iteration = 0; iteration < 64 && handle.created[0]?.newSessionCalls !== 1; iteration++) {
          t.mock.timers.tick(1);
          await Promise.resolve();
        }
        direct = handle.created[0];
      } else {
        await warmStandby(t, handle);
        const usage = handle.provider.usage;
        if (!usage) throw new Error("the provider did not register usage");
        source = usage.fetchUsage({});
        for (let iteration = 0; iteration < 64; iteration++) {
          direct = handle.created.find(connection => connection.options.ompPurpose === "quota" && connection.newSessionCalls > 0);
          if (direct) break;
          t.mock.timers.tick(1);
          await Promise.resolve();
        }
      }
      if (!direct) throw new Error(`${scenario} did not reach its gated session setup`);
      const active = direct;
      let credentialChecksWhileLive = 0;
      keychain.present = async () => {
        if (!active.closed) credentialChecksWhileLive++;
        return false;
      };
      let logoutFinished = false;
      logout = command.handler("logout", { ui: { notify() {} } }).finally(() => { logoutFinished = true; });
      // Stay below the coordinator's ten-second process-exit grace: a correct
      // implementation is still waiting here, not timing out and deleting.
      for (let iteration = 0; iteration < 16; iteration++) {
        t.mock.timers.tick(1);
        await Promise.resolve();
      }
      const finishedBeforeRelease = logoutFinished;
      gate.resolve();
      await driveToSettlement(t, Promise.all([logout, source]), `${scenario} completion after gate release`);
      assert.equal(finishedBeforeRelease, false,
        `${scenario}: logout must not finish credential removal while the direct connection is live`);
      assert.equal(credentialChecksWhileLive, 0,
        `${scenario}: credential stores must not be inspected before the direct connection exits`);
      assert.equal(active.closed, true, `${scenario}: the fixture connection closes after its gated work`);
    } finally {
      gate.resolve();
      try {
        await driveToSettlement(t, Promise.allSettled([source, logout]), `${scenario} gated cleanup`);
      } finally {
        // stopWarmup's two-second escape timer uses this mocked clock too;
        // drive it instead of leaving shutdown and restore pending forever.
        await driveToSettlement(t, handle.restore(), `${scenario} adapter restore`);
      }
    }
  }
});

test("shutdown closes a published standby without creating a session", async t => {
  const handle = await startAdapter(t);
  try {
    const warm = await warmStandby(t, handle);
    await handle.shutdown();
    assert.equal(warm.closed, true);
    assert.equal(warm.newSessionCalls, 0, "warmup never opens a session, even at shutdown");
    assert.equal(handle.created.length, 1, "shutdown must not spawn replacement connections");
  } finally {
    await handle.restore();
  }
});
