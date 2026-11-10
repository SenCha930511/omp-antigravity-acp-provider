import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MARKER,
  OmpAuthCoordinator,
  authReady,
  createKeychain,
  formatLogoutSummary,
  inspectAcpAuth,
  keychain,
  logoutFollow,
  runSecurity,
  secretService,
  type OmpCommandContext,
} from "../extension/auth-sync.ts";

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// These tests exercise the macOS keychain path on every host. Keep the Linux
// Secret Service probe out of the real user keyring unless a test overrides it.
const noSecretService = async () => undefined;
secretService.present = noSecretService;
secretService.remove = noSecretService;
const NOT_FOUND_STDERR = "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.";

interface AuthFixture {
  coordinator: OmpAuthCoordinator;
  ctx: OmpCommandContext;
  notices: string[];
  logoutCallCount: () => number;
  storeMarker: () => void;
  removeMarker: () => void;
  fireGeneration: () => void;
  followedNotices: () => string[];
}

function authCoordinatorFixture(overrides: {
  logoutAllRuntimes?: () => Promise<void>;
  closeAllRuntimes?: () => Promise<void>;
  isPoolBusy?: () => boolean;
  deferGeneration?: boolean;
} = {}): AuthFixture {
  const generationListeners: (() => void)[] = [];
  const ompCredentials = new Map<string, { refresh?: string; email?: string; authorizedAt?: number }>();
  const notices: string[] = [];
  const logouts: string[] = [];
  const ctx: OmpCommandContext = {
    ui: { notify: (text: string) => { notices.push(text); } },
    modelRegistry: {
      authStorage: {
        credentials: {
          getOAuth: (provider: string) => ompCredentials.get(provider),
          remove: async (provider: string) => {
            ompCredentials.delete(provider);
            if (!overrides.deferGeneration) for (const listener of generationListeners) listener();
          },
          onGeneration: (listener: () => void) => { generationListeners.push(listener); return () => {}; },
        },
      },
    },
  };
  const coordinator = new OmpAuthCoordinator({
    pi: { on: () => {} },
    connections: new Set(),
    isPoolBusy: overrides.isPoolBusy ?? (() => false),
    logoutAllRuntimes: overrides.logoutAllRuntimes ?? (async () => { logouts.push("logout"); }),
    closeAllRuntimes: overrides.closeAllRuntimes ?? (async () => {}),
    onSyncProvider: () => {},
  });
  const fireGeneration = () => { for (const listener of generationListeners) listener(); };
  return {
    coordinator,
    ctx,
    notices,
    logoutCallCount: () => logouts.length,
    storeMarker: () => {
      ompCredentials.set("antigravity-acp", { refresh: MARKER, authorizedAt: Date.now() });
      fireGeneration();
    },
    removeMarker: () => { ompCredentials.delete("antigravity-acp"); fireGeneration(); },
    fireGeneration,
    followedNotices: () => notices.filter(text => text.includes("finished the logout OMP started")),
  };
}

test("keychain classification separates confirmed absence from failures", async () => {
  const confirmedMissing = { code: 44, killed: false, signal: null, stderr: NOT_FOUND_STDERR };
  const failures: unknown[] = [
    { ...confirmedMissing, stderr: "security: SecKeychainSearchCopyNext: unexpected status -25308." },
    { ...confirmedMissing, stderr: undefined },
    { ...confirmedMissing, code: 1 },
    { ...confirmedMissing, code: "44" },
    { ...confirmedMissing, code: null, killed: true, signal: "SIGTERM" },
    { ...confirmedMissing, signal: "SIGKILL" },
    { ...confirmedMissing, code: "ENOENT" },
    { code: "ETIMEDOUT", killed: false, signal: null },
    new Error("spawn failure without exec metadata"),
    null,
  ];
  for (const error of failures) {
    const kc = createKeychain(async () => { throw error; }, "darwin");
    await assert.rejects(kc.present(), /Unable to inspect the Antigravity keychain entry/);
    await assert.rejects(kc.remove(), /Unable to remove the Antigravity keychain entry/);
  }
  const missing = createKeychain(async () => { throw confirmedMissing; }, "darwin");
  assert.equal(await missing.present(), false);
  assert.equal(await missing.remove(), false);
  const present = createKeychain(async () => undefined, "darwin");
  assert.equal(await present.present(), true);
  assert.equal(await present.remove(), true);
});

test("non-darwin platforms skip the subprocess entirely", async () => {
  let runnerCalls = 0;
  const kc = createKeychain(async () => { runnerCalls++; }, "linux");
  assert.equal(await kc.present(), undefined);
  assert.equal(await kc.remove(), undefined);
  assert.equal(runnerCalls, 0);
});

test("a gated runner leaves the microtask queue running", async () => {
  const gate = Promise.withResolvers<void>();
  const kc = createKeychain(() => gate.promise, "darwin");
  const pending = kc.present();
  let ran = false;
  await Promise.resolve().then(() => { ran = true; });
  assert.ok(ran, "queued microtasks must run while the keychain query is pending");
  gate.resolve();
  assert.equal(await pending, true);
});

test("runSecurity keeps the event loop responsive in a real subprocess", async () => {
  const script = `setTimeout(() => { process.stderr.write(${JSON.stringify(NOT_FOUND_STDERR)}); process.exit(44); }, 150);`;
  const kc = createKeychain(() => runSecurity(["-e", script], process.execPath), "darwin");
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 20);
  try {
    assert.equal(await kc.present(), false);
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks >= 1, `interval ticks while the keychain subprocess runs: ${ticks}`);
});

test("a hung security subprocess rejects through the timeout path", async () => {
  const kc = createKeychain(() => runSecurity(["-e", "setTimeout(() => {}, 3500);"], process.execPath), "darwin");
  await assert.rejects(kc.present(), /Unable to inspect the Antigravity keychain entry/);
});

test("durable removal fails closed and fresh login refuses", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-sync-"));
  const savedHome = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = home;
  const originalPresent = keychain.present;
  const originalRemove = keychain.remove;
  const originalRetryMs = logoutFollow.removalRetryMs;
  keychain.present = async () => true;
  keychain.remove = async () => true;
  logoutFollow.removalRetryMs = 0;
  try {
    const coordinator = new OmpAuthCoordinator({
      pi: { on: () => {} },
      connections: new Set(),
      isPoolBusy: () => false,
      logoutAllRuntimes: async () => {},
      closeAllRuntimes: async () => {},
      onSyncProvider: () => {},
    });
    const removal = await coordinator.removeStoredCredentialsDurably();
    assert.equal(removal.keychainRemoved, false,
      "three unverified rounds must report failure, not success");
    assert.equal(removal.keyringRemoved, undefined);
    await assert.rejects(coordinator.beginFreshGoogleLogin(),
      /Unable to confirm removal of the Antigravity credential store entry/);
  } finally {
    keychain.present = originalPresent;
    keychain.remove = originalRemove;
    logoutFollow.removalRetryMs = originalRetryMs;
    if (savedHome === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = savedHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("keyring auth is detected when no token file exists", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-keyring-"));
  const savedHome = process.env.GEMINI_HOME;
  const savedKey = process.env.GEMINI_API_KEY;
  const originalKeychainPresent = keychain.present;
  process.env.GEMINI_HOME = home;
  delete process.env.GEMINI_API_KEY;
  keychain.present = async () => undefined;
  secretService.present = async () => true;
  try {
    const auth = await inspectAcpAuth();
    assert.equal(auth.status, "oauth-refreshable");
    assert.equal(auth.authType, "oauth-personal");
    assert.equal(auth.keyring, true);
    assert.equal(await authReady(), true);
  } finally {
    keychain.present = originalKeychainPresent;
    secretService.present = noSecretService;
    if (savedHome === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = savedHome;
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("an absent keyring leaves auth missing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-keyring-"));
  const savedHome = process.env.GEMINI_HOME;
  const savedKey = process.env.GEMINI_API_KEY;
  const originalKeychainPresent = keychain.present;
  process.env.GEMINI_HOME = home;
  delete process.env.GEMINI_API_KEY;
  keychain.present = async () => undefined;
  secretService.present = async () => false;
  try {
    const auth = await inspectAcpAuth();
    assert.equal(auth.status, "missing");
    assert.equal(auth.keyring, undefined);
    assert.equal(await authReady(), false);
  } finally {
    keychain.present = originalKeychainPresent;
    secretService.present = noSecretService;
    if (savedHome === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = savedHome;
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("fresh login clears the Linux keyring entry", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-keyring-"));
  const savedHome = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = home;
  const originalKeychainPresent = keychain.present;
  const originalKeychainRemove = keychain.remove;
  const originalSecretPresent = secretService.present;
  const originalSecretRemove = secretService.remove;
  const originalRetryMs = logoutFollow.removalRetryMs;
  let present = true;
  let removeCalls = 0;
  keychain.present = async () => undefined;
  keychain.remove = async () => undefined;
  secretService.present = async () => present;
  secretService.remove = async () => { removeCalls++; present = false; return true; };
  logoutFollow.removalRetryMs = 0;
  try {
    const coordinator = new OmpAuthCoordinator({
      pi: { on: () => {} },
      connections: new Set(),
      isPoolBusy: () => false,
      logoutAllRuntimes: async () => {},
      closeAllRuntimes: async () => {},
      onSyncProvider: () => {},
    });
    assert.deepEqual(await coordinator.removeStoredCredentialsDurably(),
      { keychainRemoved: undefined, keyringRemoved: true });
    assert.equal(removeCalls, 1);
    await coordinator.beginFreshGoogleLogin();
  } finally {
    keychain.present = originalKeychainPresent;
    keychain.remove = originalKeychainRemove;
    secretService.present = originalSecretPresent;
    secretService.remove = originalSecretRemove;
    logoutFollow.removalRetryMs = originalRetryMs;
    if (savedHome === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = savedHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("logout summary names the system keyring entry", () => {
  assert.match(formatLogoutSummary({ keychainRemoved: undefined, keyringRemoved: true, ompMarker: "removed" }),
    /Google credentials, saved ACP sessions, the system keyring entry and the OMP marker record cleared/);
  assert.match(formatLogoutSummary({ keychainRemoved: undefined, keyringRemoved: false }),
    /The system keyring entry was not present or not removable/);
});

test("a marker restored mid-flight keeps the re-logged-in keychain entry", async () => {
  const originalPresent = keychain.present;
  const originalRemove = keychain.remove;
  let entry = false;
  let removeCalls = 0;
  keychain.present = async () => entry;
  keychain.remove = async () => { removeCalls++; entry = false; return true; };
  const originalDelayMs = logoutFollow.delayMs;
  logoutFollow.delayMs = 5;
  let releaseTeardown: () => void = () => {};
  const teardown = new Promise<void>(resolve => { releaseTeardown = resolve; });
  try {
    const fixture = authCoordinatorFixture({ closeAllRuntimes: () => teardown });
    fixture.coordinator.watchOmpCredentials(fixture.ctx);
    fixture.storeMarker();
    fixture.removeMarker();
    await settle(20);
    entry = true;
    fixture.storeMarker();
    releaseTeardown();
    await settle(40);
    assert.equal(removeCalls, 0, "the re-logged-in keychain entry must not be removed");
    assert.equal(fixture.followedNotices().length, 0);
  } finally {
    keychain.present = originalPresent;
    keychain.remove = originalRemove;
    logoutFollow.delayMs = originalDelayMs;
  }
});

test("a failed followed logout surfaces one error notice without unhandled rejections", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const originalDelayMs = logoutFollow.delayMs;
  logoutFollow.delayMs = 5;
  try {
    const fixture = authCoordinatorFixture({
      logoutAllRuntimes: async () => { throw new Error("session store clear failed"); },
    });
    fixture.coordinator.watchOmpCredentials(fixture.ctx);
    fixture.storeMarker();
    fixture.removeMarker();
    await settle(30);
    assert.equal(unhandled.length, 0, "the followed logout failure must be handled");
    const errors = fixture.notices.filter(text => text.includes("could not be finished"));
    assert.equal(errors.length, 1, `exactly one retry hint: ${JSON.stringify(fixture.notices)}`);
    assert.equal(fixture.followedNotices().length, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    logoutFollow.delayMs = originalDelayMs;
  }
});

test("a failure on the busy-retry path is also contained", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const originalDelayMs = logoutFollow.delayMs;
  const originalRetryMs = logoutFollow.retryMs;
  logoutFollow.delayMs = 5;
  logoutFollow.retryMs = 5;
  let busy = true;
  try {
    const fixture = authCoordinatorFixture({
      logoutAllRuntimes: async () => { throw new Error("session store clear failed"); },
      isPoolBusy: () => busy,
    });
    fixture.coordinator.watchOmpCredentials(fixture.ctx);
    fixture.storeMarker();
    fixture.removeMarker();
    await settle(20);
    assert.equal(fixture.notices.filter(text => text.includes("could not be finished")).length, 0,
      "a busy pool defers the followed logout before any failure can occur");
    busy = false;
    await settle(30);
    assert.equal(unhandled.length, 0);
    assert.equal(fixture.notices.filter(text => text.includes("could not be finished")).length, 1);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    logoutFollow.delayMs = originalDelayMs;
    logoutFollow.retryMs = originalRetryMs;
  }
});

test("a generation event after the command logout triggers no redundant follow", async () => {
  const originalPresent = keychain.present;
  const originalRemove = keychain.remove;
  keychain.present = async () => false;
  keychain.remove = async () => true;
  const originalDelayMs = logoutFollow.delayMs;
  logoutFollow.delayMs = 5;
  try {
    const fixture = authCoordinatorFixture({ deferGeneration: true });
    fixture.coordinator.watchOmpCredentials(fixture.ctx);
    fixture.storeMarker();
    const result = await fixture.coordinator.performCommandLogout(fixture.ctx);
    assert.equal(result.ompMarker, "removed");
    fixture.fireGeneration();
    await settle(50);
    assert.equal(fixture.logoutCallCount(), 1, "only the command logout may run");
    assert.equal(fixture.followedNotices().length, 0);
  } finally {
    keychain.present = originalPresent;
    keychain.remove = originalRemove;
    logoutFollow.delayMs = originalDelayMs;
  }
});

test("credential watcher sends followed-logout notices to the latest OMP context", async () => {
  const originalPresent = keychain.present;
  const originalRemove = keychain.remove;
  keychain.present = async () => false;
  keychain.remove = async () => true;
  const originalDelayMs = logoutFollow.delayMs;
  logoutFollow.delayMs = 5;
  try {
    const fixture = authCoordinatorFixture();
    const secondNotices: string[] = [];
    const secondCtx = { ...fixture.ctx, ui: { notify: (text: string) => { secondNotices.push(text); } } };
    fixture.coordinator.watchOmpCredentials(fixture.ctx);
    fixture.coordinator.watchOmpCredentials(secondCtx);
    fixture.coordinator.watchOmpCredentials({ ui: { notify: () => {} } } as OmpCommandContext);
    fixture.storeMarker();
    fixture.removeMarker();
    await settle(40);
    assert.ok(secondNotices.some(text => text.includes("finished the logout OMP started")));
    assert.equal(fixture.followedNotices().length, 0, "the stale first context must not receive the notice");
  } finally {
    keychain.present = originalPresent;
    keychain.remove = originalRemove;
    logoutFollow.delayMs = originalDelayMs;
  }
});
