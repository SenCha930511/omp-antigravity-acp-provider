import { test } from "node:test";
import assert from "node:assert/strict";
import { OmpSessionLifecycle, type OmpProviderSessionState } from "../extension/omp-session-lifecycle.ts";
import { toolDeclarations, normalizeOmpSystemDeltas } from "../extension/omp-context.ts";
import { AntigravityRuntime, Type } from "../extension/runtime.mjs";

function fixture() {
  const bundles = new Map<string | undefined, object>(), closed: Array<string | undefined> = [];
  const gates = new Map<string | undefined, Promise<void>>();
  const released: Array<string | undefined> = [], releaseGates = new Map<string | undefined, Promise<void>>();
  const lifecycle = new OmpSessionLifecycle(async id => {
    const bundle = bundles.get(id);
    if (!bundle) return;
    bundles.delete(id); closed.push(id);
    await lifecycle.disposeRuntime(id, bundle, () => gates.get(id) ?? Promise.resolve());
  }, async id => { released.push(id); await releaseGates.get(id); });
  const scope = () => new Map<string, OmpProviderSessionState>();
  function bind(id: string, host: Map<string, OmpProviderSessionState>) {
    const ticket = lifecycle.capture(id, host), bundle = {};
    bundles.set(id, bundle); lifecycle.attach(ticket, bundle); lifecycle.finish(ticket);
    return ticket;
  }
  return { lifecycle, bundles, closed, released, gates, releaseGates, scope, bind };
}

test("OMP closing a planning scope cannot close the main scope or its provider identity", async () => {
  const f = fixture(), main = f.scope(), plan = f.scope();
  f.bind("main", main); f.bind("plan", plan);
  plan.get("antigravity-acp")!.close();
  assert.deepEqual(f.closed, ["plan"]);
  const request = f.lifecycle.capture("main", main);
  await f.lifecycle.ready(request); f.lifecycle.finish(request);
  assert.ok(f.bundles.has("main"));
  await f.lifecycle.closeAll();
});

test("OMP /fresh closes old deferred work; a same-id replacement waits for teardown before dispatch", async () => {
  const f = fixture(), scope = f.scope(), gate = Promise.withResolvers<void>();
  f.bind("same-routing-id", scope);
  const old = f.lifecycle.capture("same-routing-id", scope);
  f.gates.set("same-routing-id", gate.promise);
  scope.get("antigravity-acp")!.close();
  const rejected = assert.rejects(f.lifecycle.ready(old), /closed before ACP dispatch/);
  const next = f.lifecycle.capture("same-routing-id", scope);
  let ready = false;
  const waiting = f.lifecycle.ready(next).then(() => { ready = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(ready, false);
  gate.resolve(); await Promise.all([rejected, waiting]);
  f.lifecycle.finish(old); f.lifecycle.finish(next);
  assert.deepEqual(f.closed, ["same-routing-id"]);
});

test("idle eviction during preparation preserves the next request and waits for its predecessor", async () => {
  const f = fixture(), scope = f.scope(), gate = Promise.withResolvers<void>();
  f.bind("idle", scope);
  const waiting = f.lifecycle.capture("idle", scope), old = f.bundles.get("idle")!;
  f.bundles.delete("idle");
  const eviction = f.lifecycle.disposeRuntime("idle", old, () => gate.promise);
  let ready = false;
  const restoring = f.lifecycle.ready(waiting).then(() => { ready = true; });
  await Promise.resolve(); await Promise.resolve(); assert.equal(ready, false);
  gate.resolve(); await Promise.all([eviction, restoring]);
  const replacement = {}; f.bundles.set("idle", replacement);
  f.lifecycle.attach(waiting, replacement); f.lifecycle.finish(waiting);
  scope.get("antigravity-acp")!.close();
  assert.deepEqual(f.closed, ["idle"], "The scope still owns the replacement after eviction");
  await f.lifecycle.closeAll();
});

test("releaseSession retires only the side request and failed preparation retains no lifecycle ownership", async () => {
  const f = fixture(), scope = f.scope();
  f.bind("main", scope); f.bind("main:side:1", scope);
  scope.get("antigravity-acp")!.releaseSession!("main:side:1");
  assert.deepEqual(f.closed, ["main:side:1"]);
  for (let i = 0; i < 32; i++) f.lifecycle.finish(f.lifecycle.capture(`failed-${i}`, scope));
  scope.get("antigravity-acp")!.close();
  assert.deepEqual(f.closed, ["main:side:1", "main"]);
  await f.lifecycle.closeAll();
});

test("global shutdown also closes a provider identity with no initialized runtime", async () => {
  const f = fixture(), ticket = f.lifecycle.capture("preparing", f.scope());
  await f.lifecycle.closeAll();
  await assert.rejects(f.lifecycle.ready(ticket), /closed before ACP dispatch/);
  f.lifecycle.finish(ticket);
});

test("final side release waits for process exit and mapping cleanup before a reused routing ID dispatches", async () => {
  const f = fixture(), scope = f.scope(), exit = Promise.withResolvers<void>(), cleanup = Promise.withResolvers<void>();
  f.bind("main", scope); f.bind("side", scope);
  f.gates.set("side", exit.promise); f.releaseGates.set("side", cleanup.promise);
  scope.get("antigravity-acp")!.releaseSession!("side");
  assert.deepEqual(f.released, []);
  const next = f.lifecycle.capture("side", scope); let ready = false;
  const waiting = f.lifecycle.ready(next).then(() => { ready = true; });
  exit.resolve();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.deepEqual(f.released, ["side"]); assert.equal(ready, false);
  cleanup.resolve(); await waiting; f.lifecycle.finish(next);
  assert.ok(f.bundles.has("main"));
  await f.lifecycle.closeAll(); assert.deepEqual(f.released, ["side"], "Ordinary shutdown must preserve saved mappings");
});

test("final release still retires saved state after idle eviction, and another scope cannot release it", async () => {
  const f = fixture(), scope = f.scope(), stranger = f.scope();
  f.bind("side", scope); f.bind("other", stranger);
  const bundle = f.bundles.get("side")!; f.bundles.delete("side");
  await f.lifecycle.disposeRuntime("side", bundle, async () => {});
  stranger.get("antigravity-acp")!.releaseSession!("side");
  await Promise.resolve(); assert.deepEqual(f.released, []);
  scope.get("antigravity-acp")!.releaseSession!("side");
  await f.lifecycle.closeAll(); assert.deepEqual(f.released, ["side"]);
});

test("reloading the adapter closes the prior generation and waits before dispatching its replacement", async () => {
  const old = fixture(), next = fixture(), scope = old.scope(), gate = Promise.withResolvers<void>();
  old.bind("same-id", scope); old.gates.set("same-id", gate.promise);
  const replacement = next.lifecycle.capture("same-id", scope);
  assert.deepEqual(old.closed, ["same-id"]);
  let ready = false;
  const waiting = next.lifecycle.ready(replacement).then(() => { ready = true; });
  await Promise.resolve(); await Promise.resolve(); assert.equal(ready, false);
  gate.resolve(); await waiting;
  next.lifecycle.finish(replacement);
  await Promise.all([old.lifecycle.closeAll(), next.lifecycle.closeAll()]);
});

test("waitClosing awaits synchronous scope.close teardowns from previously visited sessions", async () => {
  const f = fixture(), scope = f.scope(), gate = Promise.withResolvers<void>();
  f.bind("session-a", scope); f.bind("session-b", scope); f.gates.set("session-a", gate.promise);
  void scope.get("antigravity-acp")!.close();
  let drained = false;
  const waiting = f.lifecycle.waitClosing().then(() => { drained = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(drained, false);
  gate.resolve(); await waiting;
  assert.equal(drained, true);
});

test("OMP tool host state and cycles cannot change accepted history, but schema changes still do", async () => {
  const runtime: any = new AntigravityRuntime(() => {}, "yolo");
  const host: any = { requests: 1 }; host.self = host;
  const tool = { name: "read", description: "read", parameters: Type.Object({ path: Type.String() }), host };
  const fingerprint = () => runtime.ompMessageFingerprint(normalizeOmpSystemDeltas([
    { role: "system", content: "rules", toolsAdded: [tool] },
  ])[0]);
  try {
    const initial = fingerprint(); host.requests++;
    assert.equal(fingerprint(), initial);
    tool.parameters.properties.path.description = "changed schema";
    assert.notEqual(fingerprint(), initial);
    assert.deepEqual(Object.keys(toolDeclarations([tool])[0]), ["name", "description", "parameters"]);
  } finally { await runtime.close(); }
});
