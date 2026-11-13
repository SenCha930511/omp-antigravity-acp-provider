// The optional session/close RPC must never wedge process teardown or lease
// release. These fixtures stay at the SDK seam: no ACP process is spawned.
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";
import { TierConnection } from "../extension/runtime.mjs";

type CloseCapability = {} | true | false | undefined;

interface CloseFixture {
  initialize: () => Promise<unknown>;
  operationTimeoutMs: number;
  protocolFailure: Promise<never>;
  processFailure: Promise<never>;
  connection: { closeSession: () => Promise<unknown> };
  sessions: Map<string, { sessionId: string }>;
  close: () => Promise<void>;
  closeSession: (sessionId: string) => Promise<boolean>;
}

function fixture(capability: CloseCapability, close: () => Promise<unknown>, operationTimeoutMs = 1_000): CloseFixture {
  const connection = Object.create(TierConnection.prototype) as CloseFixture;
  connection.initialize = async () => ({ agentCapabilities: { sessionCapabilities: { close: capability } } });
  connection.operationTimeoutMs = operationTimeoutMs;
  connection.protocolFailure = Promise.withResolvers<never>().promise;
  connection.processFailure = Promise.withResolvers<never>().promise;
  connection.connection = { closeSession: close };
  connection.sessions = new Map([["fixture-session", { sessionId: "fixture-session" }]]);
  return connection;
}
test("object and boolean close capabilities still release the session", async () => {
  for (const capability of [{}, true] as CloseCapability[]) {
    const calls: unknown[] = [];
    const connection = fixture(capability, async () => { calls.push("close"); });
    assert.equal(await connection.closeSession("fixture-session"), true);
    assert.equal(calls.length, 1);
    assert.equal(connection.sessions.size, 0);
  }
});

test("false and missing close capabilities keep the process-close fallback", async () => {
  for (const capability of [false, undefined] as CloseCapability[]) {
    let called = false;
    const connection = fixture(capability, async () => { called = true; });
    assert.equal(await connection.closeSession("fixture-session"), false);
    assert.equal(called, false);
    assert.equal(connection.sessions.size, 1);
  }
});

test("a failing close reports false without pretending the session was released", async () => {
  const connection = fixture({}, async () => { throw new Error("synthetic close failure"); });
  assert.equal(await connection.closeSession("fixture-session"), false);
  assert.equal(connection.sessions.size, 1);
});

test("a never-settling close is bounded and starts process teardown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let closeStarted = false;
  const connection = fixture({}, () => { closeStarted = true; return Promise.withResolvers().promise; }, 25);
  let processClosed = false;
  connection.close = async () => { processClosed = true; };

  const closing = connection.closeSession("fixture-session");
  await tick();
  assert.equal(closeStarted, true, "the SDK close must be attempted before the deadline");
  t.mock.timers.tick(25);
  assert.equal(await closing, false, "a timed-out close must not report success");
  await tick();
  assert.equal(processClosed, true, "the process-close fallback must start without awaiting the hung RPC");
  assert.equal(connection.sessions.size, 1, "the hung RPC never released the session");
});
