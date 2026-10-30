// Offline: real built runtime/connection code, deterministic fake transport.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AntigravityRuntime, TierConnection } from "../extension/runtime.mjs";

const model = { id: "gemini-3.8-flash", name: "Flash", api: "antigravity-acp", provider: "antigravity-acp",
  contextWindow: 524288, maxTokens: 32000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const user = (content: string) => ({ role: "user", content, timestamp: 1 });
const partial = () => ({ role: "assistant", provider: model.provider, model: model.id, api: model.api,
  content: [{ type: "text", text: "PARTIAL" }], timestamp: 2 });
const modes = { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] };
const models = { currentModelId: model.id, availableModels: [{ modelId: model.id, name: "Flash" }] };

function fixture(persist?: (record: any) => Promise<void>) {
  const connections: any[] = [], runtimes: any[] = [];
  const saved = new Map<string, any>();
  let holdNext = false;
  let ready = Promise.withResolvers<any>();
  const factory = (options: any) => {
    const exit = Promise.withResolvers<any>();
    let pending: ReturnType<typeof Promise.withResolvers<any>> | undefined;
    const c: any = { process: { alive: true, exited: exit.promise }, prompts: [], ack: true, cancelCount: 0,
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { embeddedContext: true }, sessionCapabilities: { resume: {} } } }),
      async newSession() { c.id = randomUUID(); return { sessionId: c.id, modes, models }; },
      async resumeSession(id: string) { c.id = id; return { modes, models }; },
      getSessionState: () => ({ modes, models }),
      async prompt(request: any, signal?: AbortSignal) {
        c.prompts.push(request);
        if (!holdNext) return { stopReason: "end_turn" };
        holdNext = false; pending = Promise.withResolvers<any>();
        options.handlers.onUpdate({ sessionId: c.id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PARTIAL" } } });
        ready.resolve(c);
        const abort = () => { void c.cancel(c.id); };
        signal?.addEventListener("abort", abort, { once: true });
        try { return await pending.promise; }
        finally { signal?.removeEventListener("abort", abort); pending = undefined; }
      },
      async cancel() { c.cancelCount++; if (c.ack) pending?.resolve({ stopReason: "cancelled" }); },
      async close() { c.process.alive = false; pending?.reject(new Error("forced transport close")); exit.resolve({ code: 0 }); },
    };
    connections.push(c); return c;
  };
  function create() {
    const r: any = new AntigravityRuntime(factory, "yolo", { get: (id: string) => saved.get(id),
      save: (record: any) => persist ? persist(record).then(() => saved.set(record.piSessionId, record)) : saved.set(record.piSessionId, record), remove: (id: string) => saved.delete(id) });
    runtimes.push(r); return r;
  }
  async function run(r: any, messages: any[], signal?: AbortSignal) {
    const events: any[] = [];
    for await (const event of r.stream(model, { messages, tools: [] }, { sessionId: "test", signal }).stream) events.push(structuredClone(event));
    return events;
  }
  async function held(r: any, signal?: AbortSignal, messages = [user("OLD")]) {
    holdNext = true; ready = Promise.withResolvers<any>();
    const result = run(r, messages, signal);
    const connection = await ready.promise;
    return { result, connection, binding: [...r.resolvedBindings][0] as any };
  }
  return { connections, saved, create, run, held, close: async () => { for (const r of runtimes) await r.close(); } };
}

// The transport wrapper must return a real terminal acknowledgement instead
// of throwing away that evidence behind a generic AbortError.
{
  const base: any = Object.getPrototypeOf(TierConnection.prototype);
  const pending = Promise.withResolvers<any>();
  const signal = new AbortController();
  const transport: any = { process: { alive: true }, withProgressWatchdog: () => pending.promise,
    async cancel() { pending.resolve({ stopReason: "cancelled" }); }, async close() { this.process.alive = false; } };
  const result = base.prompt.call(transport, { sessionId: "test", prompt: [] }, signal.signal);
  signal.abort();
  assert.equal((await result).stopReason, "cancelled"); assert.ok(transport.process.alive);
}

for (const pendingKind of ["none", "tools", "permission"]) {
  const f = fixture();
  try {
    const r = f.create(); const old = await f.held(r);
    let cancelled = pendingKind === "none";
    if (pendingKind === "tools") old.binding.pendingTools.set("old-call", {
      invocation: { id: "old-call", name: "read", arguments: {} }, resolve(value: any) { cancelled = value.isError === true; },
    });
    if (pendingKind === "permission") old.binding.permission = { id: "old-permission", request: { options: [] },
      timer: setTimeout(() => {}, 10_000).unref(), resolve(value: any) { cancelled = value.outcome.outcome === "cancelled"; } };
    const next = await f.run(r, [user("OLD"), partial(), user("NEW")]);
    assert.ok(next.some(e => e.type === "done"));
    assert.ok((await old.result).some(e => e.type === "error"));
    assert.ok(cancelled, `${pendingKind} must be cancelled, never resumed into NEW`);
    assert.equal(f.connections.length, 1, `Clean ${pendingKind} cancellation should retain the connection`);
    assert.equal(old.connection.prompts.length, 2);
    assert.equal(old.connection.prompts[1].sessionId, old.connection.prompts[0].sessionId);
    const payload = JSON.stringify(old.connection.prompts[1]);
    assert.ok(payload.includes("NEW") && !payload.includes("OLD") && !payload.includes("PARTIAL"), "Send only the unseen new request");
  } finally { await f.close(); }
}

// Actual Esc first, then a new prompt; also persist and restore the cancelled
// checkpoint through a new runtime without replaying the accepted history.
{
  const f = fixture();
  try {
    const r = f.create(), controller = new AbortController();
    const old = await f.held(r, controller.signal); controller.abort();
    const events = await old.result;
    const message = events.find(e => e.type === "error").error;
    assert.ok(old.connection.process.alive);
    assert.equal(f.saved.get("test").ompCancelledCheckpoint, true);
    const id = f.saved.get("test").acpSessionId;
    await r.close();
    const restored = f.create();
    await f.run(restored, [user("OLD"), message, user("NEW_AFTER_RESTORE")]);
    assert.equal(f.connections.at(-1).id, id);
    assert.ok(!JSON.stringify(f.connections.at(-1).prompts[0]).includes("PARTIAL"));
  } finally { await f.close(); }
}

for (const reason of ["edited", "missing-partial", "timeout"]) {
  const f = fixture();
  try {
    const r = f.create(); const old = await f.held(r);
    if (reason === "timeout") old.connection.ack = false;
    const messages = reason === "edited" ? [user("EDITED"), partial(), user("NEW")]
      : reason === "missing-partial" ? [user("OLD"), user("NEW")] : [user("OLD"), partial(), user("NEW")];
    await f.run(r, messages); await old.result;
    assert.equal(f.connections.length, 2, `Uncertain ${reason} state must rebuild`);
    assert.equal(old.connection.process.alive, false);
    assert.ok(JSON.stringify(f.connections.at(-1).prompts[0]).includes("NEW"));
  } finally { await f.close(); }
}

{
  const f = fixture();
  const proto = AntigravityRuntime.prototype as any;
  const originalFingerprint = proto.ompMessagesFingerprint;
  let prefixLengthCalls = 0;
  proto.ompMessagesFingerprint = function (messages: any[]) {
    if (messages.length === 1) prefixLengthCalls++;
    return originalFingerprint.call(this, messages);
  };
  try {
    const r = f.create(); const old = await f.held(r);
    prefixLengthCalls = 0;
    const next = await f.run(r, [user("EDITED"), partial()]);
    await old.result;
    assert.ok(next.some(e => e.type === "done"));
    assert.equal(prefixLengthCalls, 1, "The supersedes judgment must fingerprint the pending prefix exactly once");
    assert.equal(f.connections.length, 2, "A modified prefix without a new user rebuilds on a fresh connection");
    assert.ok(JSON.stringify(f.connections.at(-1).prompts[0]).includes("EDITED"));
  } finally {
    proto.ompMessagesFingerprint = originalFingerprint;
    await f.close();
  }
}
console.log("An edited prefix without a new user fingerprints the pending prefix once: PASS");

{
  const f = fixture();
  try {
    const r = f.create(); const old = await f.held(r);
    const first = f.run(r, [user("OLD"), partial(), user("NEW_ONE")]);
    const second = f.run(r, [user("OLD"), partial(), user("NEW_ONE"), user("NEW_TWO")]);
    assert.ok((await first).some(e => e.type === "done"));
    assert.ok((await second).some(e => e.type === "done"));
    await old.result;
    assert.equal(f.connections.length, 1, "Queued new requests must not invalidate one another's live connection");
    assert.equal(f.connections[0].prompts.length, 3);
    assert.ok(JSON.stringify(f.connections[0].prompts[1]).includes("NEW_ONE"));
    assert.ok(JSON.stringify(f.connections[0].prompts[2]).includes("NEW_TWO"));
  } finally { await f.close(); }
}
console.log("Confirmed cancellation, queued new requests, tools/permissions, saved checkpoints and unsafe-state fallback: PASS");

// Exercise real memo entries across cancellation with the same host objects.
// In-place historical edits must still force reconstruction after a cache hit.
for (const edited of [false, true]) {
  const f = fixture();
  try {
    const r = f.create(), history = user("LARGE_HISTORY".repeat(1000));
    const old = await f.held(r, undefined, [history]);
    if (edited) history.content += "EDITED_IN_PLACE";
    const next = await f.run(r, [history, partial(), user("NEW_AFTER_CACHED_HISTORY")]);
    await old.result;
    assert.ok(next.some(e => e.type === "done"));
    assert.equal(f.connections.length, edited ? 2 : 1);
    assert.ok(JSON.stringify(f.connections.at(-1).prompts.at(-1)).includes("NEW_AFTER_CACHED_HISTORY"));
  } finally { await f.close(); }
}
console.log("Cached long history reuses acknowledged sessions; in-place edits force reconstruction: PASS");

for (const shutdown of [false, true]) {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = fixture(async record => { if (record.ompCancelledCheckpoint) { entered.resolve(); await release.promise; } });
  try {
    const r = f.create(), controller = new AbortController();
    const old = await f.held(r, controller.signal); controller.abort();
    await entered.promise;
    let finished = false;
    const next = shutdown ? r.close().then(() => { finished = true; }) :
      f.run(r, [user("OLD"), partial(), user("AFTER_ASYNC_CHECKPOINT")]).then(() => { finished = true; });
    await delay(20);
    assert.equal(finished, false, "Follow-up/shutdown must wait for the cancellation checkpoint write");
    assert.equal(old.connection.prompts.length, 1);
    release.resolve(); await next; await old.result;
    if (!shutdown) assert.equal(old.connection.prompts.length, 2);
  } finally { release.resolve(); await f.close(); }
}
{
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = fixture(async () => { entered.resolve(); await release.promise; });
  try {
    const r = f.create(), pending = f.run(r, [user("INITIAL")]);
    await entered.promise;
    const closing = r.close(); release.resolve();
    const events = await pending; await closing;
    assert.ok(events.some(e => e.type === "error"));
    assert.equal(r.resolvedBindings.size, 0, "Late initialization writes cannot resurrect a closed runtime");
  } finally { release.resolve(); await f.close(); }
}
console.log("Async checkpoint barriers protect follow-ups, shutdown and cancelled initialization: PASS");

{
  const f = fixture();
  try {
    const r = f.create(), old = await f.held(r);
    const changed = r.setPermissionMode("yolo");
    const next = f.run(r, [user("AFTER_MODE_CHANGE")]);
    const completed = await Promise.race([Promise.all([changed, next, old.result]).then(() => true), delay(1000).then(() => false)]);
    assert.equal(completed, true, "Mode changes must not await callers queued behind the mode change itself");
  } finally { await f.close(); }
}
console.log("Mode-change shutdown cannot deadlock with queued requests: PASS");

{
  const base: any = Object.getPrototypeOf(TierConnection.prototype);
  const originalPrompt = base.prompt;
  let queries = 0;
  const c: any = Object.assign(Object.create(TierConnection.prototype), {
    activePrompts: 0, usageMode: "auto", usageCommands: new Set(["test"]), usageBaselines: new Map([["test", {}]]),
    usageStatus: new Map(), contextUsage: new Map([["test", { used: 123, size: 1000 }]]),
    async readUsage() { queries++; throw new Error("Cancelled turns must not query usage"); },
  });
  try {
    base.prompt = async () => ({ stopReason: "cancelled" });
    const response = await c.prompt({ sessionId: "test", prompt: [] });
    assert.equal(queries, 0); assert.equal(response._meta.ompContextTokens, 123);
    console.log("Cancelled turns skip supplemental queries and preserve context occupancy: PASS");
  } finally { base.prompt = originalPrompt; }
}
