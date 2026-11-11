import { test } from "node:test";
import assert from "node:assert/strict";
import { TierConnection } from "../extension/tier-connection.ts";

interface UsageCapability {
  waitForUsageCommand: (sessionId: string, timeoutMs?: number, signal?: AbortSignal) => Promise<boolean>;
}

type BaseConnectionMethods = Pick<TierConnection, "newSession" | "resumeSession" | "loadSession">;

test("quota waits for advertised usage and settles on timeout or close", async (context) => {
  const originalSetHandlers = TierConnection.prototype.setHandlers;
  let handler: Parameters<TierConnection["setHandlers"]>[0]["onUpdate"];
  TierConnection.prototype.setHandlers = function (handlers) {
    handler = handlers.onUpdate;
    return originalSetHandlers.call(this, handlers);
  };
  const connection = new TierConnection({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    handlers: {},
  });
  const capability = connection as unknown as UsageCapability;
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const advertise = (sessionId: string, command: string) => handler?.({
    sessionId,
    update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: command, description: "fixture" }] },
  });
  try {
    assert.equal(typeof capability.waitForUsageCommand, "function");
    assert.equal(await capability.waitForUsageCommand("unsupported", 0), false);
    const waiting = capability.waitForUsageCommand("supported");
    queueMicrotask(() => { void advertise("supported", "usage"); });
    assert.equal(await waiting, true);
    const negative = capability.waitForUsageCommand("negative");
    queueMicrotask(() => { void advertise("negative", "help"); });
    assert.equal(await negative, false, "a full list without /usage must resolve an existing waiter");
    void advertise("supported", "help");
    assert.equal(await capability.waitForUsageCommand("supported", 0), false, "a later full list must remove a previously advertised command");
    const controller = new AbortController();
    const cancelledWait = capability.waitForUsageCommand("cancel-wait", 5000, controller.signal);
    queueMicrotask(() => controller.abort());
    assert.equal(await cancelledWait, false, "aborting a subscriber must settle the advertisement wait");
    const registry = connection as unknown as { usageCommandWaiters: Map<string, Set<(available: boolean) => void>> };
    assert.equal(registry.usageCommandWaiters.has("cancel-wait"), false, "abort must remove the waiter and its listener");

    const expiring = capability.waitForUsageCommand("timeout");
    context.mock.timers.tick(5000);
    assert.equal(await expiring, false);
    const closing = capability.waitForUsageCommand("closing");
    await connection.close();
    assert.equal(await closing, false);
  } finally {
    TierConnection.prototype.setHandlers = originalSetHandlers;
    await connection.close();
    context.mock.timers.reset();
  }
});

test("initial session command lists seed usage support for new, resumed, and loaded sessions", async () => {
  const parent = Object.getPrototypeOf(TierConnection.prototype) as BaseConnectionMethods;
  const original = { newSession: parent.newSession, resumeSession: parent.resumeSession, loadSession: parent.loadSession };
  const usage = [{ name: "usage", description: "Official quota report" }];
  parent.newSession = async () => ({ sessionId: "new-usage", availableCommands: usage });
  parent.resumeSession = async () => ({ availableCommands: usage });
  parent.loadSession = async () => ({ availableCommands: [] });
  const connection = new TierConnection({
    cwd: process.cwd(), command: process.execPath, args: ["-e", "setTimeout(() => {}, 1000)"], handlers: {},
  });
  const capability = connection as unknown as UsageCapability;
  try {
    await connection.newSession(process.cwd());
    assert.equal(await capability.waitForUsageCommand("new-usage", 0), true);
    await connection.resumeSession("resumed-usage", process.cwd());
    assert.equal(await capability.waitForUsageCommand("resumed-usage", 0), true);
    await connection.loadSession("loaded-without-usage", process.cwd());
    assert.equal(await capability.waitForUsageCommand("loaded-without-usage", 0), false);

    parent.newSession = async () => ({ sessionId: "new-without-usage", availableCommands: [] });
    await connection.newSession(process.cwd());
    assert.equal(await capability.waitForUsageCommand("new-without-usage", 0), false);
  } finally {
    parent.newSession = original.newSession;
    parent.resumeSession = original.resumeSession;
    parent.loadSession = original.loadSession;
    await connection.close();
  }
});
