// Offline integration through the built runtime; no Google process or live quota.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { AntigravityRuntime, AcpSessionStore, SessionCleanup, TierConnection, resolveAntigravityAcpDirectory } from "../extension/runtime.mjs";


const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-cleanup-runtime-")));
const stateDir = path.join(root, "state"), acpDir = path.join(root, "acp");
fs.mkdirSync(path.join(acpDir, "conversations"), { recursive: true });
const cleanup = new SessionCleanup(stateDir, acpDir);
const previousEnvironment = { HOME: process.env.HOME, GEMINI_HOME: process.env.GEMINI_HOME };
const restoreAuthenticationEnvironment = () => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};
process.env.HOME = root;
process.env.GEMINI_HOME = path.join(root, "gemini");
const connections: any[] = [];
let fail = false;
let failSetModel = false;
let stopReason = "end_turn";
let quotaQueries = 0;
let quotaAdvertised = true;
let quotaModelSelections = 0;
let quotaPromptSignal: AbortSignal | undefined;
const quotaSignals: Array<{ phase: string; signal?: AbortSignal }> = [];
type Deferred<T> = { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void };
type QuotaResponse = { stopReason: string };
type QuotaProbeState = { quotaInFlights: Set<{ snapshot: Promise<unknown>; controller: AbortController }>; quotaCacheOwner?: string };
let pendingQuota: { gate: Deferred<QuotaResponse>; started: Deferred<void> } | undefined;
function holdNextQuota() {
  pendingQuota = { gate: Promise.withResolvers<QuotaResponse>(), started: Promise.withResolvers<void>() };
  return pendingQuota;
}
const quotaChunks = ["### Quota Limits\n- **Gemini 4 Argon**", "\n  - **Five hour limit:** 42% remaining (resets Nov 10, 2026, 18:30 UTC)"];
const modes = { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] };
const models = { currentModelId: "gemini-3.8-flash", availableModels: [{ modelId: "gemini-3.8-flash", name: "Flash" }] };
function factory(options) {
  let exited!: (value: any) => void;
  const processState = { alive: true, pid: process.pid, exited: new Promise(resolve => { exited = resolve; }) };
  let lease: string | undefined, id: string | undefined;
  let abortPending: (() => void) | undefined;
  const connection = {
    process: processState,
    async initialize(signal?: AbortSignal) {
      if (options.ompPurpose === "quota") quotaSignals.push({ phase: "initialize", signal });
      return { protocolVersion: 1, authMethods: [{ id: "api-key", name: "API key", _meta: { "api-key": true } }], agentCapabilities: { promptCapabilities: { embeddedContext: true } } };
    },
    async authenticate(_request: unknown, signal?: AbortSignal) {
      if (options.ompPurpose === "quota") quotaSignals.push({ phase: "authenticate", signal });
    },
    async newSession(_cwd?: string, signal?: AbortSignal) {
      if (options.ompPurpose === "quota") quotaSignals.push({ phase: "newSession", signal });
      id = randomUUID();
      fs.writeFileSync(path.join(acpDir, "conversations", `${id}.db`), "history");
      lease = await cleanup.acquire(id, true, process.pid);
      return { sessionId: id, modes, models };
    },
    getSessionState() { return { modes, models }; },
    async waitForUsageCommand(_sessionId?: string, _timeoutMs?: number, signal?: AbortSignal) {
      if (options.ompPurpose === "quota") quotaSignals.push({ phase: "waitForUsageCommand", signal });
      return quotaAdvertised;
    },
    async setModel(_session?: string, _model?: string, signal?: AbortSignal) {
      if (options.ompPurpose === "quota") quotaSignals.push({ phase: "setModel", signal });
      if (failSetModel) throw new Error("synthetic setModel failure");
      if (options.ompPurpose === "quota") quotaModelSelections++;
    },
    async prompt(request, signal?: AbortSignal) {
      if (request.prompt[0]?.text === "/usage") {
        assert.equal(options.ompPurpose, "quota", "Quota connections must be marked as non-inference queries");
        assert.equal(quotaAdvertised, true, "An unavailable quota command must stop before this prompt");
        quotaQueries++;
        if (options.ompPurpose === "quota") quotaSignals.push({ phase: "prompt", signal });
        for (const text of quotaChunks) {
          await options.handlers?.onUpdate({ sessionId: id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
        }
        const pending = pendingQuota;
        if (pending) {
          pendingQuota = undefined;
          quotaPromptSignal = signal;
          abortPending = () => pending.gate.reject(Object.assign(new Error("Antigravity ACP request aborted"), { code: "aborted" }));
          signal?.addEventListener("abort", abortPending, { once: true });
          pending.started.resolve();
          if (signal?.aborted) abortPending();
          try {
            return await pending.gate.promise;
          } finally {
            signal?.removeEventListener("abort", abortPending);
            abortPending = undefined;
          }
        }
        return { stopReason: "end_turn" };
      }
      if (fail) throw new Error("synthetic replacement failure");
      return { stopReason };
    },
    async retireForReplacement(key: string, session: string) { await cleanup.retire(key, session); },
    async confirmReplacement(key: string, session: string) { await cleanup.confirm(key, session); },
    async discardSession(session: string) { await cleanup.retire(`discovery:${session}`, session); await cleanup.confirm(`discovery:${session}`, "discovery-complete"); },
    async close() {
      if (!processState.alive) return;
      abortPending?.();
      processState.alive = false;
      if (lease) await cleanup.release(lease);
      exited({ code: 0 });
    },
    get id() { return id; },
  };
  connections.push(connection);
  return connection;
}
const runtime = new AntigravityRuntime(factory, "yolo", new AcpSessionStore(path.join(stateDir, "sessions.json")));
const model = { id: "gemini-3.8-flash", name: "Flash", api: "antigravity-acp", provider: "antigravity-acp",
  contextWindow: 524288, maxTokens: 32000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
async function turn(text: string) {
  const writer = runtime.stream(model, { messages: [{ role: "user", content: text, timestamp: 1 }], tools: [] }, { sessionId: "fixture", signal: AbortSignal.timeout(10_000) });
  const events: any[] = [];
  for await (const event of writer.stream) events.push(event);
  return events;
}
try {
  const authDir = path.join(root, "gemini", "antigravity-acp");
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const tokenPath = path.join(authDir, "acp_token.json");
  const settingsPath = path.join(authDir, "settings.json");
  fs.writeFileSync(tokenPath, JSON.stringify({ refresh_token: "offline-fixture-not-a-secret" }), { mode: 0o600 });
  fs.writeFileSync(settingsPath, JSON.stringify({ auth: { type: "oauth-personal" }, theme: "dark" }), { mode: 0o600 });
  assert.equal(resolveAntigravityAcpDirectory(), authDir, "logout may only touch the temporary auth directory");

  assert.ok((await turn("original history")).some(e => e.type === "done"));
  const discovered = await runtime.discoverModels();
  assert.equal(discovered.length, 1);
  const discoveryId = connections.at(-1).id;
  assert.equal(fs.existsSync(path.join(acpDir, "conversations", `${discoveryId}.db`)), false, "Discovery session must be discarded and cleaned on close");
  const first = connections[0].id;
  fail = true;
  assert.ok((await turn("compacted summary")).some(e => e.type === "error"));
  assert.ok(fs.existsSync(path.join(acpDir, "conversations", `${first}.db`)), "Failed replacement must retain the old session");
  fail = false;
  stopReason = "max_tokens";
  assert.ok((await turn("compacted summary")).some(e => e.type === "done"));
  assert.ok(fs.existsSync(path.join(acpDir, "conversations", `${first}.db`)), "Incomplete replacement must retain the old session");
  stopReason = "end_turn";
  assert.ok((await turn("compacted summary")).some(e => e.type === "done"));
  assert.equal(fs.existsSync(path.join(acpDir, "conversations", `${first}.db`)), false, "Actual runtime must confirm successful reconstruction");
  const current = connections.at(-1).id;
  assert.ok(fs.existsSync(path.join(acpDir, "conversations", `${current}.db`)));

  // Ephemeral (!persistent) session ending with max_tokens or error must still be discarded and cleaned up
  stopReason = "max_tokens";
  const ephemeralEvents: any[] = [];
  for await (const e of runtime.stream(model, { messages: [{ role: "user", content: "ephemeral turn", timestamp: 1 }], tools: [] }).stream) {
    ephemeralEvents.push(e);
  }
  assert.ok(ephemeralEvents.some(e => e.type === "done"));
  const ephemeralId = connections.at(-1).id;
  assert.equal(fs.existsSync(path.join(acpDir, "conversations", `${ephemeralId}.db`)), false, "Ephemeral session must be discarded even when stopReason is max_tokens");

  // Partial createBinding initialization failure after newSession() must discard the half-initialized session
  failSetModel = true;
  const altModel = { ...model, id: "gemini-4-argon" };
  const initFailEvents: any[] = [];
  for await (const e of runtime.stream(altModel as any, { messages: [{ role: "user", content: "init fail", timestamp: 1 }], tools: [] }, { sessionId: "partial-init" }).stream) {
    initFailEvents.push(e);
  }
  failSetModel = false;
  assert.ok(initFailEvents.some(e => e.type === "error"));
  const partialInitId = connections.at(-1).id;
  assert.equal(fs.existsSync(path.join(acpDir, "conversations", `${partialInitId}.db`)), false, "Half-initialized session must be discarded when createBinding fails after newSession()");

  const realNow = Date.now;
  let quotaNow = realNow();
  Date.now = () => quotaNow;
  try {
    const [quota, concurrentQuota] = await Promise.all([runtime.quota(undefined), runtime.quota(undefined)]);
    assert.deepEqual(concurrentQuota, quota);
    assert.equal(quotaQueries, 1, "Concurrent quota views must share one ACP /usage request");
    assert.deepEqual(quota.groups, [{ displayName: "Gemini 4 Argon", buckets: [
      { window: "5h", remainingFraction: 0.42, resetTime: "2026-11-10T18:30:00.000Z" },
    ] }]);
    assert.deepEqual(await runtime.quota(undefined), quota, "A recent quota snapshot must be reused");
    assert.equal(quotaQueries, 1, "The recent cache must not issue another /usage request");
    quotaNow += 60_000;
    const expired = await runtime.quota(undefined);
    assert.equal(expired.at, quotaNow);
    assert.equal(quotaQueries, 2, "The cache must refresh once its 60-second lifetime expires");
    assert.equal(quotaModelSelections, 2, "Short-lived sessions must confirm their advertised current model before checking usage support");
    assert.deepEqual(expired.groups, quota.groups);
    const quotaId = connections.at(-1).id;
    assert.notEqual(quotaId, current, "Quota must not use the inference session");
    assert.equal(fs.existsSync(path.join(acpDir, "conversations", `${quotaId}.db`)), false,
      "The short-lived quota session must be discarded after ACP closes");
    quotaAdvertised = false;
    quotaNow += 60_000;
    await assert.rejects(runtime.quota(undefined), /did not advertise|not advertise/);
    assert.equal(quotaQueries, 2, "An unadvertised quota command must never reach session/prompt");
    quotaAdvertised = true;
    await runtime.quota(undefined);
    assert.equal(quotaQueries, 3, "A failed quota query must not be cached permanently");

    const firstOwner = "synthetic-first-owner-key", secondOwner = "synthetic-second-owner-key";
    quotaNow += 60_000;
    const ownerQueries = quotaQueries;
    const ownerHold = holdNextQuota();
    const firstOwned = runtime.quota(firstOwner);
    await ownerHold.started.promise;
    const secondOwned = runtime.quota(secondOwner);
    const coalescedOwned = runtime.quota(firstOwner);
    assert.equal((await secondOwned).groups[0]!.displayName, "Gemini 4 Argon");
    assert.equal(quotaQueries, ownerQueries + 2, "A different owner must not join the active single-flight");
    ownerHold.gate.resolve({ stopReason: "end_turn" });
    assert.deepEqual(await coalescedOwned, await firstOwned, "Only same-owner callers coalesce");
    assert.equal(quotaQueries, ownerQueries + 2);
    await runtime.quota(firstOwner);
    assert.equal(quotaQueries, ownerQueries + 2, "The matching owner still receives the normal 60-second cache");
    await runtime.quota(secondOwner);
    assert.equal(quotaQueries, ownerQueries + 3, "A different owner cannot reuse the recent cached owner snapshot");
    const ownerFingerprint = (runtime as unknown as QuotaProbeState).quotaCacheOwner!;
    assert.equal(ownerFingerprint.includes(firstOwner), false, "Only an opaque owner fingerprint is retained");
    assert.equal(ownerFingerprint.includes(secondOwner), false);

    quotaNow += 60_000;
    const sharedHold = holdNextQuota();
    const firstSubscriber = new AbortController(), secondSubscriber = new AbortController();
    const first = runtime.quota(undefined, firstSubscriber.signal);
    let secondSettled = false;
    const second = runtime.quota(undefined, secondSubscriber.signal);
    void second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    await sharedHold.started.promise;
    firstSubscriber.abort();
    await assert.rejects(first);
    assert.equal(quotaPromptSignal?.aborted, false, "One cancelled subscriber must not abort another subscriber's ACP prompt");
    assert.equal(secondSettled, false);
    sharedHold.gate.resolve({ stopReason: "end_turn" });
    assert.equal((await second).groups[0]!.displayName, "Gemini 4 Argon");

    quotaNow += 60_000;
    const cancelledHold = holdNextQuota();
    const lastSubscriber = new AbortController();
    quotaSignals.length = 0;
    const cancelled = runtime.quota("synthetic-cancellation-owner", lastSubscriber.signal);
    await cancelledHold.started.promise;
    const cancelledOperation = [...(runtime as unknown as QuotaProbeState).quotaInFlights][0]!.snapshot as Promise<unknown>;
    const sharedSignal = quotaPromptSignal;

    assert.deepEqual(quotaSignals.map(entry => entry.phase), ["initialize", "authenticate", "newSession", "setModel", "waitForUsageCommand", "prompt"]);
    for (const entry of quotaSignals) assert.equal(entry.signal, sharedSignal, `${entry.phase} must receive the shared operation signal`);
    lastSubscriber.abort();
    await assert.rejects(cancelled);
    assert.equal(sharedSignal?.aborted, true, "Cancelling the last subscriber must abort the underlying operation immediately");
    await assert.rejects(cancelledOperation, (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "aborted",
    "abort must reject the operation without fabricating a terminal reply");

    const retryHold = holdNextQuota();
    const retry = runtime.quota("synthetic-cancellation-owner");
    await retryHold.started.promise;
    const replacement = [...(runtime as unknown as QuotaProbeState).quotaInFlights];
    assert.equal(replacement.length, 1, "an aborted request must not be reused");
    assert.equal(replacement[0]!.controller.signal.aborted, false);
    assert.notEqual(replacement[0]!.snapshot, cancelledOperation);
    retryHold.gate.resolve({ stopReason: "end_turn" });
    assert.equal((await retry).groups[0]!.displayName, "Gemini 4 Argon");

    quotaNow += 60_000;
    const truncatedHold = holdNextQuota();
    const truncated = runtime.quota(undefined);
    await truncatedHold.started.promise;
    truncatedHold.gate.resolve({ stopReason: "max_tokens" });
    await assert.rejects(truncated, /stopped with reason max_tokens/, "Even parseable partial text must not hide a truncated response");

    quotaNow += 60_000;
    const closingHold = holdNextQuota();
    const closingQuery = runtime.quota(undefined);
    await closingHold.started.promise;
    const closingOperation = [...(runtime as unknown as QuotaProbeState).quotaInFlights][0]!.snapshot as Promise<unknown>;
    const closing = runtime.close();
    assert.equal(quotaPromptSignal?.aborted, true, "Runtime close must abort the shared operation, independently of transport teardown");
    await assert.rejects(closingQuery, /aborted|closed/);
    await assert.rejects(closingOperation, /aborted|closed/);
    await closing;
  } finally {
    Date.now = realNow;
  }

  const quotaBeforeLogout = { at: Date.now(), groups: [] };
  const flushGate = Promise.withResolvers<void>();
  const logoutRuntime = Object.assign(Object.create(AntigravityRuntime.prototype), {
    disposed: false,
    quotaCache: quotaBeforeLogout,
    quotaCacheOwner: "managed",
    quotaInFlights: new Set(),
    bindingEpoch: 0,
    bindings: new Map(),
    resolvedBindings: new Set(),
    activeConnections: new Set(),
    ompSystemMemo: { clear() {} },
    ompToolsMemo: { clear() {} },
    sessionStore: { flush: () => flushGate.promise, clear: async () => {} },
  });
  assert.deepEqual(await logoutRuntime.quota(undefined), quotaBeforeLogout, "a live snapshot may be read before logout");
  const pendingLogout = logoutRuntime.logout();
  await assert.rejects(logoutRuntime.quota(undefined), { code: "process_exit" }, "logout must stop new quota reads while cleanup is pending");
  assert.equal(logoutRuntime.quotaCache, undefined);
  assert.equal(logoutRuntime.quotaCacheOwner, undefined);
  flushGate.resolve();
  await pendingLogout;
  assert.equal(fs.existsSync(tokenPath), false, "only the temporary token file may be removed");
  const clearedSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(clearedSettings, "auth"), false, "only the temporary auth section may be cleared");
  assert.equal(clearedSettings.theme, "dark", "unrelated settings remain intact inside the fixture");
  await assert.rejects(logoutRuntime.quota(undefined), { code: "process_exit" });

  await runtime.close();
  assert.ok(fs.existsSync(path.join(acpDir, "conversations", `${current}.db`)), "Normal shutdown must retain resumable state");
  console.log("Built runtime reconstruction, failed replacement, successful cleanup and normal shutdown: PASS");

  const parent: any = Object.getPrototypeOf(TierConnection.prototype);
  const originalResume = parent.resumeSession, originalClose = parent.close, originalNewSession = parent.newSession;
  const id = randomUUID(); let leased = false, released = false;
  const resumeAcquire: { owned?: boolean; waitMs?: number } = {};
  const tier: any = Object.assign(Object.create(TierConnection.prototype), {
    process: { alive: true, pid: process.pid }, cleanupLeases: new Map(), usageBaselines: new Map(), pendingOwned: new Set(),
    cleanup: { acquire(got: string, owned: boolean, _pid: number, waitMs?: number) { assert.equal(got, id); resumeAcquire.owned = owned; resumeAcquire.waitMs = waitMs; leased = true; return "lease"; },
      release() { assert.equal(tier.process.alive, false); released = true; } },
  });
  try {
    parent.resumeSession = async () => { assert.ok(leased, "Lease must exist before official resume dispatch"); return {}; };
    parent.close = async function() { this.process.alive = false; };
    await tier.resumeSession(id, root);
    assert.equal(resumeAcquire.owned, false);
    assert.equal(resumeAcquire.waitMs, 5000, "the recovery path carries the bounded lock budget");
    tier.getSessionState = () => ({});
    let unloadedReleased = false;
    tier.cleanup.release = () => { unloadedReleased = true; };
    tier.cleanup.retire = () => {};
    await tier.retireForReplacement("sid:fixture", id);
    assert.ok(unloadedReleased, "Failed restore must release its pre-acquired lease before replacement runs");
    tier.cleanupLeases.set(id, "lease");
    tier.cleanup.release = () => { assert.equal(tier.process.alive, false); released = true; };
    await tier.close();
    assert.ok(released);
    const created = randomUUID(); let newSessionWaitMs = -1;
    parent.newSession = async () => ({ sessionId: created });
    tier.cleanup = { acquire(got: string, _owned: boolean, _pid: number, waitMs?: number) { assert.equal(got, created); newSessionWaitMs = waitMs; return "lease"; }, release() {} };
    await tier.newSession();
    assert.equal(newSessionWaitMs, undefined, "new session registration keeps the default fail-fast acquisition");
  } finally { parent.resumeSession = originalResume; parent.close = originalClose; parent.newSession = originalNewSession; }
  console.log("Actual TierConnection leases before replay and releases only after process exit: PASS");

  const contendedId = randomUUID();
  await cleanup.acquire(contendedId, true, process.pid);
  const registryFile = path.join(stateDir, fs.readdirSync(stateDir).find(name => name.startsWith("cleanup-sessions-"))!);
  const realAcquireRetry = (cleanup as any).acquireRetry;
  let openSleep: () => void = () => {};
  const sleepGate = new Promise<void>(resolve => { openSleep = resolve; });
  (cleanup as any).acquireRetry = { now: Date.now, sleep: () => sleepGate };
  fs.mkdirSync(registryFile + ".lock");
  const gatedTier: any = Object.assign(Object.create(TierConnection.prototype), {
    process: { alive: true, pid: process.pid }, cleanupLeases: new Map(), cleanup,
  });
  let dispatched = false;
  parent.resumeSession = async () => { dispatched = true; return {}; };
  const resuming = gatedTier.resumeSession(contendedId, root);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(dispatched, false, "the official resume RPC must not dispatch while the registry is contended");
  fs.rmdirSync(registryFile + ".lock");
  openSleep();
  await resuming;
  assert.ok(dispatched, "dispatch follows the acquired lease once contention clears");
  assert.ok(gatedTier.cleanupLeases.has(contendedId), "the waiting acquisition registers its lease");
  (cleanup as any).acquireRetry = realAcquireRetry;
  parent.resumeSession = originalResume;
  console.log("Contended recovery waits for the lease before dispatching resume: PASS");

  const active = randomUUID();
  fs.writeFileSync(path.join(acpDir, "conversations", `${active}.db`), "owned");
  const lease = await cleanup.acquire(active, true, process.pid);
  await cleanup.retire("peer", active); await cleanup.confirm("peer", randomUUID());
  const result = execFileSync(process.execPath, ["--input-type=module", "-e",
    'import {SessionCleanup} from ' + JSON.stringify(new URL("../extension/runtime.mjs", import.meta.url).href) + ';' +
    'const c=new SessionCleanup(process.argv[1],process.argv[2]);console.log(await c.collect());', stateDir, acpDir], { encoding: "utf8" });
  assert.equal(result.trim(), "0", "A separate real OS process must honor the parent's live lease");
  assert.ok(fs.existsSync(path.join(acpDir, "conversations", `${active}.db`)));
  await cleanup.release(lease);
  assert.equal(fs.existsSync(path.join(acpDir, "conversations", `${active}.db`)), false);
  console.log("Separate-process cleanup respects live shared leases: PASS");
} finally {
  try { await runtime.close(); await cleanup.stop(); }
  finally { restoreAuthenticationEnvironment(); fs.rmSync(root, { recursive: true, force: true }); }
}
