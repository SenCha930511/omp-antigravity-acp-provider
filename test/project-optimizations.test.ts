import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { Diagnostics } from "../extension/diagnostics.ts";
import { CatalogStore, type ConfiguredCatalogModel } from "../extension/catalog-store.ts";
import { SessionRuntimePool } from "../extension/runtime-pool.ts";
import { registerOmpAdapter } from "../extension/index.ts";
import type { OmpCommandContext } from "../extension/auth-sync.ts";
import { selectRuntimeModel } from "../extension/model-catalog.ts";
import { Type } from "../extension/runtime.mjs";

test("actual OMP wrapper refreshes tool audit for same-array additions/removals and schema/name edits", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tools-mutable-"));
  const hooks = new Map<string, Function>(), traces: string[] = [];
  const originalError = console.error, previousTrace = process.env.OMP_ACP_TRACE;
  let provider: any;
  try {
    process.env.OMP_ACP_TRACE = "1";
    // The wrapper publishes the audit it actually used through its trace line.
    console.error = (...args: unknown[]) => {
      if (args[0] === "[ACP tools]" && typeof args[1] === "string") traces.push(args[1]);
    };
    await registerOmpAdapter({ on: (name: string, fn: Function) => hooks.set(name, fn), registerTool() {},
      registerProvider: (_name: string, value: any) => { provider = value; },
      registerCommand() {} }, state);
    assert.equal(provider.usage?.id, "antigravity-acp");
    assert.equal(typeof provider.usage?.fetchUsage, "function");
    const tools: any[] = [{ name: "read", description: "read", parameters: Type.Object({ path: Type.String() }) }];
    async function audit(): Promise<{ offered: string[]; available: string[]; omitted: Array<{ name: string; reason: string }> }> {
      // Abort before startup: exercises real tool projection, but never spawns
      // ACP, reads credentials or sends a model request.
      for await (const _ of provider.streamSimple(provider.models[0], { messages: [{ role: "user", content: "synthetic", timestamp: 1 }], tools }, { signal: AbortSignal.abort() })) {}
      const trace = traces.pop();
      assert.ok(trace, "the wrapper must publish the tool audit it used");
      return JSON.parse(trace);
    }
    assert.deepEqual((await audit()).available, ["read"]);
    tools.push({ name: "bash", parameters: Type.Object({ cmd: Type.String() }) });
    assert.deepEqual((await audit()).available, ["read", "bash"]);
    tools.splice(0, 1); assert.deepEqual((await audit()).available, ["bash"]);
    tools[0].name = "renamed"; assert.deepEqual((await audit()).available, ["renamed"]);
    tools[0].parameters.type = "array";
    const omitted = (await audit()).omitted;
    assert.deepEqual(omitted.map(tool => tool.name), ["renamed"]);
    assert.match(omitted[0]!.reason, /schema omitted/);
  } finally {
    console.error = originalError;
    if (previousTrace === undefined) delete process.env.OMP_ACP_TRACE;
    else process.env.OMP_ACP_TRACE = previousTrace;
    await hooks.get("session_shutdown")?.({}, {});
    await fs.rm(state, { recursive: true, force: true });
  }
});

test("inference refuses to start ACP when the local Google login is absent", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-preflight-"));
  const geminiHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-preflight-home-"));
  const previousHome = process.env.GEMINI_HOME, previousKey = process.env.GEMINI_API_KEY;
  const { keychain, secretService } = await import("../extension/auth-sync.ts");
  const previousPresent = keychain.present;
  const previousSecretPresent = secretService.present;
  let provider: any, spawns = 0;
  try {
    process.env.GEMINI_HOME = geminiHome;
    delete process.env.GEMINI_API_KEY;
    keychain.present = async () => false;
    // Inference shares authReady(); keep the Linux keyring probe synthetic so
    // the preflight can never read the real user keyring.
    secretService.present = async () => false;
    await registerOmpAdapter({ on: () => {}, registerTool() {},
      registerProvider: (_name: string, value: any) => { provider = value; },
      registerCommand() {} }, state, () => { spawns++; throw new Error("ACP must not spawn"); });
    const events: any[] = [];
    for await (const event of provider.streamSimple(provider.models[0],
      { messages: [{ role: "user", content: "synthetic", timestamp: 1 }], tools: [] }, {})) events.push(event);
    assert.match(events.find(event => event.type === "error")?.error.errorMessage ?? "", /not signed in.*\/login/i);
    assert.equal(spawns, 0);
  } finally {
    keychain.present = previousPresent;
    secretService.present = previousSecretPresent;
    if (previousHome === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = previousHome;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previousKey;
    await fs.rm(state, { recursive: true, force: true });
    await fs.rm(geminiHome, { recursive: true, force: true });
  }
});

test("the initial offline catalog includes Argon without spawning ACP", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "omp-offline-argon-"));
  let models: ConfiguredCatalogModel[] | undefined;
  let spawns = 0;
  try {
    await registerOmpAdapter({
      on() {},
      registerTool() {},
      registerCommand() {},
      registerProvider: (_name, value) => {
        if (!value || typeof value !== "object" || !("models" in value) || !Array.isArray(value.models)) {
          throw new Error("provider did not expose its model catalog");
        }
        models = value.models as ConfiguredCatalogModel[];
      },
    }, state, () => { spawns++; throw new Error("offline catalog must not spawn ACP"); });
    const argon = models?.find(model => model.id === "gemini-4-argon");
    assert.ok(argon, "Argon must be selectable before dynamic discovery succeeds");
    assert.equal(argon.name, "Gemini 4 Argon");
    assert.equal(argon.contextWindow, 1_000_000);
    assert.equal(argon.maxTokens, 65_536);
    assert.equal(argon.reasoning, true);
    assert.deepEqual(argon.thinking?.efforts, ["low", "medium", "high"]);
    assert.equal(selectRuntimeModel(argon, "low").thinkingLevelMap?.low, "gemini-4-argon-low");
    assert.equal(selectRuntimeModel(argon, "high").thinkingLevelMap?.high, "gemini-4-argon-high");
    assert.equal(spawns, 0);
  } finally { await fs.rm(state, { recursive: true, force: true }); }
});

test("catalog discovery refuses to prepare ACP when auth preflight fails", async () => {
  let prepared = 0, auth = 0;
  const store = new CatalogStore("/nonexistent/models.json", {} as any,
    async () => { prepared++; }, () => [], async () => { auth++; throw new Error("not signed in"); });
  await assert.rejects(store.discoverModels(), /not signed in/);
  assert.equal(auth, 1);
  assert.equal(prepared, 0);
});

test("idle runtime cap evicts LRU only, protects leases/busy work and awaits pending teardown", async () => {
  const closed: number[] = []; let serial = 0, busy = false;
  const pool = new SessionRuntimePool(() => ({ id: ++serial }), async entry => { closed.push(entry.id); },
    { timeoutMs: 0, maxIdleEntries: 1, canDispose: () => !busy });
  const active = pool.acquire("active");
  const old = pool.get("old"); pool.get("recent");
  assert.deepEqual(closed, [old.id]); assert.ok(pool.peek("active"));
  busy = true; pool.get("busy"); assert.ok(pool.peek("recent"));
  busy = false; active.release();
  assert.equal(pool.values().length, 1);
  await pool.closeAll(); assert.equal(new Set(closed).size, serial);
});

test("model discovery is single-flight, shares failure and retries on next refresh", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "omp-discovery-shared-"));
  try {
    const store: any = new CatalogStore(path.join(state, "models.json"), {} as any, async () => {}, () => []);
    let calls = 0, fail = true;
    store.discoverOnce = async () => { calls++; await Promise.resolve(); if (fail) throw new Error("synthetic"); return [{ modelId: "gemini-3.8-flash", name: "Flash" }]; };
    const failed = await Promise.allSettled([store.refresh({ defaults: {}, models: {} }), store.refresh({ defaults: {}, models: {} })]);
    assert.equal(calls, 1); assert.ok(failed.every(r => r.status === "rejected"));
    fail = false;
    await Promise.all([store.refresh({ defaults: {}, models: {} }), store.refresh({ defaults: {}, models: {} })]);
    assert.equal(calls, 2); assert.equal(store.currentModels[0].id, "gemini-3.8-flash");
  } finally { await fs.rm(state, { recursive: true, force: true }); }
});

test("catalog discovery skips a model that rejects selection", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "omp-discovery-skip-"));
  try {
    const sessionState = { configOptions: [{
      id: "model", category: "model", type: "select", currentValue: "good",
      options: [{ value: "bad", name: "Bad" }, { value: "good", name: "Good" }],
    }] };
    const connection = {
      async initialize() {},
      async newSession() { return { sessionId: "session", ...sessionState }; },
      async setModel(_sessionId: string, value: string) {
        if (value === "bad") throw new Error("unavailable");
      },
      getSessionState() { return sessionState; },
      async discardSession() {},
      async close() {},
    };
    const store = new CatalogStore(path.join(state, "models.json"), {} as any, async () => {}, () => [],
      async () => {}, () => connection as any);
    const models = await store.discoverModels();
    assert.deepEqual(models.map(model => model.modelId), ["good"]);
  } finally { await fs.rm(state, { recursive: true, force: true }); }
});

test("shared refresh uses the latest settings and removes stale model entries", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "omp-refresh-settings-"));
  try {
    const store = new CatalogStore(path.join(state, "models.json"), {} as any, async () => {}, () => []);
    const gate = Promise.withResolvers<any[]>();
    store.discoverModels = () => gate.promise;
    const first = store.refresh({ defaults: { contextWindow: 65536 }, models: {} });
    const second = store.refresh({ defaults: { contextWindow: 131072 }, models: {} });
    gate.resolve([{ modelId: "gemini-3.8-flash", name: "Flash" }]);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b); assert.equal(a[0].contextWindow, 131072);
    store.projectWithSettings([], { defaults: {}, models: {} });
    assert.equal(store.upstreamModels.size, 0);
  } finally { await fs.rm(state, { recursive: true, force: true }); }
});

test("catalog reads and reconfiguration keep current models and lookup state consistent", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "omp-catalog-state-"));
  try {
    const file = path.join(state, "models.json");
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 2, models: [{ modelId: "custom", name: "Custom" }] }));
    const store = new CatalogStore(file, {} as any, async () => {}, () => []);
    const defaults = { defaults: {}, models: {} };
    store.loadInitialOrCached(defaults);
    const original = store.getDynamicModels(defaults);
    const changed = store.reconfigure({ defaults: { contextWindow: 65536 }, models: {} });
    assert.equal(changed[0].contextWindow, 65536);
    assert.equal(store.getDynamicModels(defaults)[0].contextWindow, 32768);
    assert.equal(store.currentModels, store.getDynamicModels(defaults));
    assert.equal(store.upstreamModels.get("custom"), store.currentModels[0]);
    store.reconfigure({ defaults: { contextWindow: 65536 }, models: {} });
    assert.equal(store.reconfigure(defaults)[0].contextWindow, original[0].contextWindow,
      "Removing an override restores the source model limits");

    const before = store.currentModels;
    assert.throws(() => store.projectWithSettings([
      ...before, { ...before[0], id: "invalid", contextWindow: 4096, maxTokens: 8192 },
    ], defaults), /Invalid token budgets/);
    assert.equal(store.currentModels, before);
    assert.equal(store.upstreamModels.size, 1, "Failed projection cannot partially replace the live catalog");
  } finally { await fs.rm(state, { recursive: true, force: true }); }
});

test("catalog cache notices in-place settings changes and reuses missing-file fallbacks", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "omp-catalog-fallback-"));
  try {
    let reads = 0;
    const store = new CatalogStore(path.join(state, "missing.json"), {} as any, async () => {}, () => {
      reads++;
      return [{ id: "custom", contextWindow: 32768, maxTokens: 8192 } as any];
    });
    const settings = { defaults: { contextWindow: 65536 }, models: {} };
    const first = store.getDynamicModels(settings);
    assert.equal(store.getDynamicModels(settings), first);
    assert.equal(reads, 1);
    settings.defaults.contextWindow = 131072;
    assert.equal(store.getDynamicModels(settings)[0].contextWindow, 131072);
  } finally { await fs.rm(state, { recursive: true, force: true }); }
});

test("account session counts reuse unchanged files but follow rewrites and stat failures", async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "omp-account-count-"));
  const file = path.join(state, "sessions.json");
  const hooks = new Map<string, (event: unknown, ctx: OmpCommandContext) => unknown>();
  const notices: string[] = [];
  let command: { handler: (args: string, ctx: OmpCommandContext) => Promise<void> } | undefined;
  const ctx = { ui: { notify: (message: string) => notices.push(message) } } as OmpCommandContext;
  const writeRecords = async (count: number) => {
    await fs.writeFile(file, JSON.stringify(Array.from({ length: count }, (_, index) => ({ piSessionId: `session-${index}` }))));
  };
  try {
    await writeRecords(1);
    await registerOmpAdapter({
      on: (name, fn) => hooks.set(name, fn),
      registerTool() {},
      registerProvider() {},
      registerCommand: (_name, value) => { command = value; },
    }, state);
    const read = t.mock.method(fsSync, "readFileSync");
    const sessionReads = () => read.mock.calls.filter(call => call.arguments[0] === file).length;
    await command!.handler("account", ctx);
    assert.match(notices.at(-1)!, /Saved ACP sessions: 1/);
    assert.equal(sessionReads(), 1);
    await command!.handler("account", ctx);
    assert.equal(sessionReads(), 1, "an unchanged fingerprint must reuse the parsed count");
    await writeRecords(2);
    await command!.handler("account", ctx);
    assert.match(notices.at(-1)!, /Saved ACP sessions: 2/);
    assert.equal(sessionReads(), 2, "an external rewrite must invalidate the fingerprint");

    const originalStat = fsSync.statSync;
    t.mock.method(fsSync, "statSync", (target, options) => {
      if (target === file) throw Object.assign(new Error("synthetic transient stat failure"), { code: "EMFILE" });
      return originalStat(target, options);
    });
    await writeRecords(3);
    await command!.handler("account", ctx);
    assert.match(notices.at(-1)!, /Saved ACP sessions: 3/);
    assert.equal(sessionReads(), 3, "a stat failure must fall through to a fresh read");
    await command!.handler("account", ctx);
    assert.equal(sessionReads(), 4, "a transient stat failure must not become a cached zero or stale count");
  } finally {
    await hooks.get("session_shutdown")?.({}, ctx);
    await fs.rm(state, { recursive: true, force: true });
  }
});

test("failed catalog persistence leaves the live catalog intact", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "omp-catalog-commit-"));
  try {
    const file = path.join(state, "models.json");
    const store = new CatalogStore(file, {} as any, async () => {}, () => []);
    const original = store.projectWithSettings([{ id: "old", contextWindow: 32768, maxTokens: 8192 } as any],
      { defaults: {}, models: {} });
    store.discoverModels = async () => [{ modelId: "new", name: "New" }];
    await fs.mkdir(file);
    await assert.rejects(store.refresh({ defaults: {}, models: {} }));
    assert.equal(store.currentModels, original);
    assert.deepEqual([...store.upstreamModels.keys()], ["old"]);
    assert.deepEqual((await fs.readdir(state)).filter(name => name.endsWith(".tmp")), []);
  } finally { await fs.rm(state, { recursive: true, force: true }); }
});

test("global shutdown waits for a detached runtime teardown", async () => {
  const gate = Promise.withResolvers<void>();
  const pool = new SessionRuntimePool(() => ({}), () => gate.promise);
  pool.get("closing");
  const closing = pool.close("closing");
  let stopped = false;
  const stopping = pool.closeAll().then(() => { stopped = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(stopped, false);
  gate.resolve(); await Promise.all([closing, stopping]);
  assert.equal(stopped, true);
});

test("diagnostics defaults off, bounds samples, persists only enablement and clears on disable", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "omp-diagnostics-"));
  try {
    const file = path.join(state, "diagnostics.json"), d = new Diagnostics(file);
    d.record("ignored", 1); assert.equal(d.status().samples, 0);
    d.configure(true); for (let i = 0; i < 200; i++) d.record("history.compare", i);
    assert.equal(d.status().samples, 128);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { enabled: true });
    assert.equal(new Diagnostics(file).status().enabled, true);
    d.configure(false); assert.equal(d.status().samples, 0);
  } finally { await fs.rm(state, { recursive: true, force: true }); }
});

test("diagnostics groups every stage and preserves its existing upper-median reporting", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "omp-diagnostics-stages-"));
  try {
    const d = new Diagnostics(path.join(state, "diagnostics.json"));
    d.configure(true);
    for (const [stage, ms] of [["alpha", 3], ["beta", 9], ["alpha", 1], ["beta", 11], ["alpha", 2]] as const) d.record(stage, ms);
    assert.deepEqual(d.status().stages, {
      alpha: { count: 3, medianMs: 2, maxMs: 3 },
      beta: { count: 2, medianMs: 11, maxMs: 11 },
    });
  } finally { await fs.rm(state, { recursive: true, force: true }); }
});

test("idle timeout rejects values that Node would turn into a one-millisecond timer", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "omp-timeout-range-"));
  const previous = process.env.OMP_ACP_IDLE_TIMEOUT_MS;
  try {
    process.env.OMP_ACP_IDLE_TIMEOUT_MS = "2147483648";
    await assert.rejects(registerOmpAdapter({ on() {}, registerTool() {}, registerProvider() {}, registerCommand() {} }, state),
      /OMP_ACP_IDLE_TIMEOUT_MS/);
  } finally {
    if (previous === undefined) delete process.env.OMP_ACP_IDLE_TIMEOUT_MS;
    else process.env.OMP_ACP_IDLE_TIMEOUT_MS = previous;
    await fs.rm(state, { recursive: true, force: true });
  }
});
