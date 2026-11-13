import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { mock } from "node:test";
import { TierConnection } from "../extension/runtime.mjs";

async function probe(capability) {
  const closeCalls = [];
  const connection = Object.create(TierConnection.prototype);
  connection.protocolFailure = new Promise(() => {});
  connection.processFailure = new Promise(() => {});
  connection.initialize = async () => ({ agentCapabilities: { sessionCapabilities: { close: capability } } });
  connection.connection = {
    closeSession: async request => { closeCalls.push(request); },
  };
  connection.sessions = new Map([["fixture-session", { sessionId: "fixture-session" }]]);
  const closed = await connection.closeSession("fixture-session");
  return { capability, closed, closeCalls, remainingSessions: connection.sessions.size };
}

const results = [];
for (const capability of [{}, true, false, undefined]) results.push(await probe(capability));
assert.deepEqual(results, [
  { capability: {}, closed: true, closeCalls: [{ sessionId: "fixture-session" }], remainingSessions: 0 },
  { capability: true, closed: true, closeCalls: [{ sessionId: "fixture-session" }], remainingSessions: 0 },
  { capability: false, closed: false, closeCalls: [], remainingSessions: 1 },
  { capability: undefined, closed: false, closeCalls: [], remainingSessions: 1 },
]);
console.log("ACP close capability object, boolean, false and missing fallback: PASS");

// A hanging SDK close must be bounded by the injected operation timeout and
// must start the process-close fallback instead of wedging teardown.
const timeoutConnection = Object.create(TierConnection.prototype);
const timeoutCalls = [];
timeoutConnection.protocolFailure = Promise.withResolvers().promise;
timeoutConnection.processFailure = Promise.withResolvers().promise;
timeoutConnection.initialize = async () => ({ agentCapabilities: { sessionCapabilities: { close: {} } } });
timeoutConnection.operationTimeoutMs = 25;
timeoutConnection.connection = { closeSession: () => Promise.withResolvers().promise };
timeoutConnection.sessions = new Map([["fixture-session", { sessionId: "fixture-session" }]]);
timeoutConnection.close = async () => { timeoutCalls.push("process-close"); };
mock.timers.enable({ apis: ["setTimeout"] });
try {
  const closing = timeoutConnection.closeSession("fixture-session");
  await tick();
  mock.timers.tick(25);
  assert.equal(await closing, false);
  assert.deepEqual(timeoutCalls, ["process-close"]);
  assert.equal(timeoutConnection.sessions.size, 1);
} finally {
  mock.timers.reset();
}
console.log("ACP close timeout returns false and starts the process-close fallback: PASS");
