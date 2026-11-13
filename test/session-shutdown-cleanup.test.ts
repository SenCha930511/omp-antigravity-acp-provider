import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { registerOmpAdapter } from "../extension/index.ts";
import { AcpSessionStore, AntigravityRuntime, SessionCleanup } from "../extension/runtime.mjs";
import type { OmpCommandContext } from "../extension/auth-sync.ts";
import type { TierConnection } from "../extension/tier-connection.ts";

type Hook = (event: unknown, ctx: OmpCommandContext) => unknown;
type Command = { handler: (args: string, ctx: OmpCommandContext) => Promise<void> };
type Runtime = { snapshot: () => Promise<unknown>; close: () => Promise<void> };
type Cleaner = { flushStoreNotes: () => Promise<void>; stop: () => Promise<void> };

test("session_shutdown finishes cleanup after runtime teardown rejection and preserves other pool entries", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-shutdown-cleanup-")));
  const state = path.join(root, "agent", "antigravity-acp-provider");
  await fs.mkdir(state, { recursive: true });
  // Even the non-managed launch short-circuit must never fall through to an
  // update check or read an actual user's configuration.
  await fs.writeFile(path.join(state, "config.json"), JSON.stringify({ permissions: "yolo", runtimeUpdates: "off" }));

  const environment = {
    HOME: path.join(root, "home"),
    GEMINI_HOME: path.join(root, "gemini"),
    GEMINI_API_KEY: "offline-shutdown-fixture",
    AGY_ACP_BIN: process.execPath,
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    OMP_ACP_IDLE_TIMEOUT_MS: "0",
    OMP_ACP_MAX_IDLE_RUNTIMES: "0",
    OMP_ACP_USAGE: "off",
  };
  const savedEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);

  const hooks = new Map<string, Hook>();
  const runtimeIds = new Map<object, string>();
  const closedRuntimes: string[] = [];
  const events: string[] = [];
  let sessionStoreFlushes = 0;
  const notices: string[] = [];
  const teardownFailure = new Error("synthetic teardown failure");
  let command: Command | undefined;
  let acquiringSession: string | undefined;
  let failingRuntime: object | undefined;

  const originalSessionStoreFlush = AcpSessionStore.prototype.flush;
  const originalSnapshot = AntigravityRuntime.prototype.snapshot;
  const originalClose = AntigravityRuntime.prototype.close;
  const originalFlush = SessionCleanup.prototype.flushStoreNotes;
  const originalStop = SessionCleanup.prototype.stop;
  AntigravityRuntime.prototype.snapshot = function (this: Runtime) {
    if (acquiringSession && !runtimeIds.has(this)) runtimeIds.set(this, acquiringSession);
    return originalSnapshot.call(this);
  };
  AntigravityRuntime.prototype.close = function (this: Runtime) {
    const id = runtimeIds.get(this) ?? "unregistered";
    if (this === failingRuntime) {
      events.push(`runtime.close:${id}:rejected`);
      return Promise.reject(teardownFailure);
    }
    closedRuntimes.push(id);
    events.push(`runtime.close:${id}`);
    return originalClose.call(this);
  };
  AcpSessionStore.prototype.flush = async function (this: AcpSessionStore) {
    sessionStoreFlushes++;
    events.push("sessionStore.flush");
    await originalSessionStoreFlush.call(this);
  };
  SessionCleanup.prototype.flushStoreNotes = async function (this: Cleaner) {
    events.push("cleanup.flushStoreNotes");
    await originalFlush.call(this);
  };
  SessionCleanup.prototype.stop = async function (this: Cleaner) {
    events.push("cleanup.stop:start");
    await originalStop.call(this);
    events.push("cleanup.stop:end");
  };

  let serial = 0;
  try {
    const createConnection: NonNullable<ConstructorParameters<typeof registerOmpAdapter>[2]> = options => {
      const exited = Promise.withResolvers<{ code: number }>();
      const processHandle = { alive: true, pid: process.pid, exited: exited.promise, generation: ++serial };
      const sessionId = randomUUID();
      const sessionState = {
        modes: { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] },
        models: {
          currentModelId: "gemini-3.8-flash",
          availableModels: [{ modelId: "gemini-3.8-flash", name: "Offline Flash" }],
        },
      };
      const connection = {
        process: processHandle,
        activePrompts: 0,
        contextUsage: new Map(),
        usageStatus: new Map(),
        async initialize() {
          return { protocolVersion: 1, agentCapabilities: {} };
        },
        async newSession() { return { sessionId, ...sessionState }; },
        getSessionState() { return sessionState; },
        async setModel(_id: string, model: string) { sessionState.models.currentModelId = model; },
        async discardSession() {},
        waitForUsageCommand() { return true; },
        async prompt() {
          await options.handlers.onUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "### Quota Limits\n- **Fixture Models**\n  - **weekly:** 100% remaining" },
            },
          });
          return { stopReason: "end_turn" };
        },
        async close() {
          if (!processHandle.alive) return;
          processHandle.alive = false;
          exited.resolve({ code: 0 });
        },
      };
      return connection as unknown as TierConnection;
    };

    await registerOmpAdapter({
      on(name: string, handler: Hook) { hooks.set(name, handler); },
      registerTool() {},
      registerProvider() {},
      registerCommand(_name: string, registered: Command) { command = registered; },
    }, state, createConnection);
    assert.ok(command);
    const shutdown = hooks.get("session_shutdown");
    assert.ok(shutdown, "the actual adapter shutdown hook must be registered");

    const context = (sessionId?: string): OmpCommandContext => ({
      ui: { notify: (message: string) => { notices.push(message); } },
      ...(sessionId === undefined ? {} : { sessionManager: { getSessionId: () => sessionId } }),
    });
    const createRuntime = async (sessionId: string): Promise<object> => {
      const before = new Set(runtimeIds.keys());
      acquiringSession = sessionId;
      try { await command.handler("status", context(sessionId)); }
      finally { acquiringSession = undefined; }
      assert.match(notices.at(-1) ?? "", /Antigravity ACP \(OMP adapter\)/, "the real status path must inspect the pool runtime");
      const created = [...runtimeIds].find(([runtime]) => !before.has(runtime));
      assert.ok(created, "status must create a genuine pool runtime");
      assert.equal(created[1], sessionId);
      return created[0];
    };

    // First prove close -> flush -> stop -> original rejection with no other
    // pool entry. These wrappers retain the production cleanup methods.
    failingRuntime = await createRuntime("failing-session");
    await assert.rejects(shutdown({}, context("failing-session")), error => {
      assert.equal(error, teardownFailure, "the exact original teardown error must escape");
      events.push("session_shutdown:rejected");
      return true;
    });
    assert.deepEqual(events, [
      "runtime.close:failing-session:rejected",
      "sessionStore.flush",
      "cleanup.flushStoreNotes",
      "cleanup.stop:start",
      "cleanup.flushStoreNotes",
      "cleanup.stop:end",
      "session_shutdown:rejected",
    ]);
    assert.deepEqual(closedRuntimes, []);
    assert.equal(sessionStoreFlushes, 1, "the failed scoped shutdown still reaches the adapter flush");

    // A separate shutdown in this same fixture proves that closeIdle does not
    // unconditionally tear down an unrelated live pool entry. stop already ran
    // above only when the failed shutdown left the pool empty.
    await createRuntime("surviving-session");
    await createRuntime("idle-session");
    events.length = 0;
    closedRuntimes.length = 0;
    const beforeIdleFlush = sessionStoreFlushes;
    await assert.doesNotReject(shutdown({}, context("idle-session")));
    assert.deepEqual(closedRuntimes, ["idle-session"]);
    assert.deepEqual(events, [
      "runtime.close:idle-session",
      "sessionStore.flush", // runtime.closeBindings
      "sessionStore.flush", // the adapter's session_shutdown path
      "cleanup.flushStoreNotes",
    ]);
    assert.ok(runtimeIds.size === 3, "all three pool runtimes were created by the actual adapter command pipeline");
    assert.equal(sessionStoreFlushes - beforeIdleFlush, 2, "normal scoped close flushes in runtime and in the adapter");
    const beforeGlobalFlush = sessionStoreFlushes;
    const globalEventStart = events.length;
    await assert.doesNotReject(shutdown({}, context()));
    assert.deepEqual(events.slice(globalEventStart), [
      "runtime.close:surviving-session",
      "sessionStore.flush", "sessionStore.flush",
      "cleanup.flushStoreNotes",
      "cleanup.stop:start", "cleanup.flushStoreNotes", "cleanup.stop:end",
    ], "the global path also flushes notes and stops after the pool is empty");
    assert.deepEqual(closedRuntimes, ["idle-session", "surviving-session"], "the global shutdown still uses its established full-pool path");
    assert.equal(sessionStoreFlushes - beforeGlobalFlush, 2,
      "global close flushes in runtime and still runs the adapter's session-store flush");
  } finally {
    // Finish every pool entry before restoring wrappers or deleting test state.
    // The no-session branch is the adapter's actual closePool cleanup path.
    failingRuntime = undefined;
    try { await hooks.get("session_shutdown")?.({}, { ui: { notify() {} } }); } catch { /* best-effort fixture teardown */ }
    AcpSessionStore.prototype.flush = originalSessionStoreFlush;
    AntigravityRuntime.prototype.snapshot = originalSnapshot;
    AntigravityRuntime.prototype.close = originalClose;
    SessionCleanup.prototype.flushStoreNotes = originalFlush;
    SessionCleanup.prototype.stop = originalStop;
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
