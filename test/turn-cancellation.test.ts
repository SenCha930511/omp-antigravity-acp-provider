import { test } from "node:test";
import assert from "node:assert/strict";
import { armSteerGiveup, drainCancelledTurn, deferredAbortSignal, steerTimings } from "../extension/turn-cancellation.ts";
import { setImmediate as tick } from "node:timers/promises";

test("drain stops old waits and waits for terminal completion before accepting another request", async () => {
  const pending = Promise.withResolvers<void>();
  const steps: string[] = [];
  const binding = { session: { sessionId: "old" }, turnCompletion: pending.promise,
    connection: { async cancel(id: string) { assert.equal(id, "old"); steps.push("cancel"); pending.resolve(); } } };
  assert.equal(await drainCancelledTurn(binding, () => steps.push("stop-waits")), true);
  assert.deepEqual(steps, ["stop-waits", "cancel"]);
});
test("unacknowledged, failed or pre-aborted cancellation requests require reconstruction", async () => {
  const never = Promise.withResolvers<void>();
  const binding = { session: { sessionId: "old" }, turnCompletion: never.promise,
    connection: { async cancel() {} } };
  assert.equal(await drainCancelledTurn(binding, () => {}, undefined, 10), false);
  assert.equal(await drainCancelledTurn({ ...binding, connection: { async cancel() { throw new Error("closed"); } } }, () => {}), false);
  assert.equal(await drainCancelledTurn(binding, () => {}, AbortSignal.abort()), false);
});

test("steerTimings validates the steering grace windows", () => {
  assert.deepEqual(steerTimings({}), { idleMs: 60_000, maxMs: 300_000 });
  assert.deepEqual(steerTimings({ OMP_ACP_STEER_GRACE_MS: "0" }), { idleMs: 0, maxMs: 300_000 });
  assert.deepEqual(steerTimings({ OMP_ACP_STEER_GRACE_MS: "600000" }), { idleMs: 600_000, maxMs: 300_000 });
  assert.deepEqual(steerTimings({ OMP_ACP_STEER_GRACE_MAX_MS: "0" }), { idleMs: 60_000, maxMs: 0 });
  assert.deepEqual(steerTimings({ OMP_ACP_STEER_GRACE_MAX_MS: "3600000" }), { idleMs: 60_000, maxMs: 3_600_000 });
  assert.throws(() => steerTimings({ OMP_ACP_STEER_GRACE_MS: "abc" }), /OMP_ACP_STEER_GRACE_MS/);
  assert.throws(() => steerTimings({ OMP_ACP_STEER_GRACE_MS: "600001" }), /OMP_ACP_STEER_GRACE_MS/);
  assert.throws(() => steerTimings({ OMP_ACP_STEER_GRACE_MS: "-1" }), /OMP_ACP_STEER_GRACE_MS/);
  assert.throws(() => steerTimings({ OMP_ACP_STEER_GRACE_MAX_MS: "abc" }), /OMP_ACP_STEER_GRACE_MAX_MS/);
  assert.deepEqual(steerTimings({ OMP_ACP_STEER_GRACE_MAX_MS: "100" }), { idleMs: 60_000, maxMs: 100 });
  assert.throws(() => steerTimings({ OMP_ACP_STEER_GRACE_MAX_MS: "99" }), /OMP_ACP_STEER_GRACE_MAX_MS/);
  assert.throws(() => steerTimings({ OMP_ACP_STEER_GRACE_MAX_MS: "3600001" }), /OMP_ACP_STEER_GRACE_MAX_MS/);
});

test("unsupported session/cancel freezes retained output and waits for natural completion", async () => {
  const pending = Promise.withResolvers<void>();
  const unsupported = Object.assign(new Error("Method not found: session/cancel"), { code: -32601 });
  const muted: string[] = [];
  const binding = { session: { sessionId: "old" }, turnCompletion: pending.promise,
    connection: { async cancel() { throw unsupported; }, muteSteerChunks(id: string) { muted.push(id); } } };
  const drained = drainCancelledTurn(binding, () => {}, undefined, 10, { idleMs: 500, maxMs: 0 });
  await tick();
  assert.deepEqual(muted, ["old"], "the grace path must freeze retained chunks before waiting");
  pending.resolve();
  assert.equal(await drained, true);
});

test("unsupported session/cancel expires the grace and requires reconstruction", async () => {
  const never = Promise.withResolvers<void>();
  const unsupported = Object.assign(new Error("Method not found"), { code: -32601 });
  const binding = { session: { sessionId: "old" }, turnCompletion: never.promise,
    connection: { async cancel() { throw unsupported; } } };
  assert.equal(await drainCancelledTurn(binding, () => {}, undefined, 10, { idleMs: 20, maxMs: 0 }), false);
});

test("a zero grace keeps the legacy immediate failure for unsupported session/cancel", async () => {
  const never = Promise.withResolvers<void>();
  const unsupported = Object.assign(new Error("Method not found"), { code: -32601 });
  const binding = { session: { sessionId: "old" }, turnCompletion: never.promise,
    connection: { async cancel() { throw unsupported; } } };
  assert.equal(await drainCancelledTurn(binding, () => {}, undefined, 10, { idleMs: 0, maxMs: 300_000 }), false);
});

test("steer grace extends while the draining turn keeps producing updates", async () => {
  const pending = Promise.withResolvers<void>();
  const unsupported = Object.assign(new Error("Method not found"), { code: -32601 });
  const muted: string[] = [];
  const listeners = new Set<() => void>();
  const binding = { session: { sessionId: "old" }, turnCompletion: pending.promise,
    connection: {
      async cancel() { throw unsupported; },
      muteSteerChunks(id: string) { muted.push(id); },
      onSteerActivity(id: string, listener: () => void) { assert.equal(id, "old"); listeners.add(listener); return () => listeners.delete(listener); },
    } };
  const drained = drainCancelledTurn(binding, () => {}, undefined, 10, { idleMs: 60, maxMs: 0 });
  await tick();
  assert.deepEqual(muted, ["old"], "the grace path must freeze retained chunks before waiting");
  const dribble = setInterval(() => { for (const listener of [...listeners]) listener(); }, 20);
  try {
    await new Promise(resolve => setTimeout(resolve, 150));
    pending.resolve();
    assert.equal(await drained, true, "an alive turn must not expire the silence window");
  } finally { clearInterval(dribble); }
});

test("steer grace still expires at the absolute cap while updates keep arriving", async () => {
  const pending = Promise.withResolvers<void>();
  const unsupported = Object.assign(new Error("Method not found"), { code: -32601 });
  const listeners = new Set<() => void>();
  const binding = { session: { sessionId: "old" }, turnCompletion: pending.promise,
    connection: {
      async cancel() { throw unsupported; },
      onSteerActivity(_id: string, listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    } };
  const dribble = setInterval(() => { for (const listener of [...listeners]) listener(); }, 10);
  try {
    assert.equal(await drainCancelledTurn(binding, () => {}, undefined, 10, { idleMs: 60_000, maxMs: 120 }), false,
      "the absolute cap must bound even a continuously active turn");
  } finally { clearInterval(dribble); }
  pending.resolve();
});

test("armSteerGiveup resets on activity, fires after silence and stops on dispose", async () => {
  let fired = 0;
  const listeners = new Set<() => void>();
  const source = { onSteerActivity(_id: string, listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); } };
  const giveup = armSteerGiveup(source, "s", { idleMs: 50, maxMs: 0 }, () => fired++);
  await new Promise(resolve => setTimeout(resolve, 15));
  for (const listener of [...listeners]) listener();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(fired, 0, "activity must reset the silence window");
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(fired, 1, "silence past the window must fire exactly once");
  giveup.dispose();
  const quiet = armSteerGiveup(undefined, "s", { idleMs: 25, maxMs: 0 }, () => fired++);
  quiet.dispose();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fired, 1, "dispose must cancel a pending fire");
});

test("deferredAbortSignal holds the transport abort while the turn stays alive", async () => {
  const controller = new AbortController();
  const listeners = new Set<() => void>();
  const deferred = deferredAbortSignal(controller.signal, { idleMs: 50, maxMs: 0 },
    { source: { onSteerActivity(_id: string, listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); } }, sessionId: "s" });
  controller.abort();
  await tick();
  assert.equal(deferred.signal.aborted, false, "the derived signal must survive the caller abort");
  const dribble = setInterval(() => { for (const listener of [...listeners]) listener(); }, 15);
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(deferred.signal.aborted, false, "ongoing activity must keep holding the abort");
  clearInterval(dribble);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(deferred.signal.aborted, true, "silence past the window must still abort the transport");
  assert.equal(deferredAbortSignal(controller.signal, { idleMs: 0, maxMs: 300_000 }).signal, controller.signal, "zero grace passes the signal through");
  const passthrough = deferredAbortSignal(new AbortController().signal, { idleMs: 50, maxMs: 0 });
  passthrough.dispose();
  assert.equal(passthrough.signal.aborted, false, "dispose must clear the pending grace timer");
});
