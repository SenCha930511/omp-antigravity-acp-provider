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
  type FreshGoogleLoginAttempt,
  type OmpCommandContext,
} from "../extension/auth-sync.ts";
import { createSecretService } from "../extension/secret-service.ts";

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// These tests exercise the macOS keychain path on every host. Keep the Linux
// Secret Service probe away from the real user keyring unless a test opts in.
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
  emit: (name: string, event: unknown) => void;
}

function authCoordinatorFixture(overrides: {
  logoutAllRuntimes?: () => Promise<void>;
  closeAllRuntimes?: () => Promise<void>;
  isPoolBusy?: () => boolean;
  deferGeneration?: boolean;
  watchableCredentials?: boolean;
} = {}): AuthFixture {
  const generationListeners: (() => void)[] = [];
  const piHandlers = new Map<string, ((event: unknown, ctx: OmpCommandContext) => unknown)[]>();
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
          ...(overrides.watchableCredentials === false ? {} : {
            onGeneration: (listener: () => void) => { generationListeners.push(listener); return () => {}; },
          }),
        },
      },
    },
  };
  const coordinator = new OmpAuthCoordinator({
    pi: {
      on: (name, handler) => {
        const handlers = piHandlers.get(name) ?? [];
        handlers.push(handler);
        piHandlers.set(name, handlers);
      },
    },
    connections: new Set(),
    isPoolBusy: overrides.isPoolBusy ?? (() => false),
    logoutAllRuntimes: overrides.logoutAllRuntimes ?? (async () => { logouts.push("logout"); }),
    closeAllRuntimes: overrides.closeAllRuntimes ?? (async () => {}),
    onSyncProvider: () => {},
  });
  const fireGeneration = () => { for (const listener of generationListeners) listener(); };
  const emit = (name: string, event: unknown) => {
    for (const handler of piHandlers.get(name) ?? []) handler(event, ctx);
  };
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
    emit,
  };
}

// beginFreshGoogleLogin deletes files from the ACP directory; keep that inside
// a throwaway GEMINI_HOME so no test can reach the real login.
async function withTempGeminiHome(run: () => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-sync-"));
  const savedHome = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = home;
  try {
    await run();
  } finally {
    if (savedHome === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = savedHome;
    await fs.rm(home, { recursive: true, force: true });
  }
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

test("macOS keychain accepts the CLI account and removes both accounts", async () => {
  const calls: string[][] = [];
  const present = new Set(["antigravity"]);
  const kc = createKeychain(async args => {
    calls.push(args);
    const account = args[args.indexOf("-a") + 1];
    if (args[0] === "find-generic-password" && present.has(account)) return;
    if (args[0] === "delete-generic-password" && present.delete(account)) return;
    throw { code: 44, killed: false, signal: null, stderr: NOT_FOUND_STDERR };
  }, "darwin");

  assert.equal(await kc.present(), true);
  assert.deepEqual(calls.slice(0, 2), [
    ["find-generic-password", "-s", "gemini", "-a", "antigravity-acp"],
    ["find-generic-password", "-s", "gemini", "-a", "antigravity"],
  ]);

  calls.length = 0;
  assert.equal(await kc.remove(), true);
  assert.deepEqual(calls, [
    ["delete-generic-password", "-s", "gemini", "-a", "antigravity-acp"],
    ["delete-generic-password", "-s", "gemini", "-a", "antigravity"],
  ]);
  assert.equal(present.size, 0);
});

test("authReady accepts a CLI-only keychain login", async () => {
  const originalPresent = keychain.present;
  const savedApiKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const missing = { code: 44, killed: false, signal: null, stderr: NOT_FOUND_STDERR };
  let lookedUpCli = false;
  keychain.present = createKeychain(async args => {
    const account = args[args.indexOf("-a") + 1];
    if (account === "antigravity") {
      lookedUpCli = true;
      return;
    }
    throw missing;
  }, "darwin").present;
  try {
    await withTempGeminiHome(async () => {
      assert.equal(await authReady(), true);
      assert.equal(lookedUpCli, true, "authReady must consult the CLI keychain account");
      assert.equal(await authReady({ allowKeychain: false }), false,
        "the managed channel must not trust a CLI-only keychain login");
    });
  } finally {
    keychain.present = originalPresent;
    if (savedApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedApiKey;
  }
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
    const fixture = authCoordinatorFixture();
    const result = await fixture.coordinator.performCommandLogout(fixture.ctx);
    assert.equal(result.keychainRemoved, false,
      "three unverified rounds must report failure, not success");
    assert.equal(result.keyringRemoved, undefined, "no Linux keyring applies to this host");
    await assert.rejects(fixture.coordinator.beginFreshGoogleLogin(),
      /Unable to confirm removal of the Antigravity/);
  } finally {
    keychain.present = originalPresent;
    keychain.remove = originalRemove;
    logoutFollow.removalRetryMs = originalRetryMs;
    if (savedHome === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = savedHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});

// The Linux Secret Service item is a complete local login: the ACP server reads
// it before its file store, so no acp_token.json exists to inspect.
test("a keyring login is oauth-refreshable when no token file exists", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-keyring-"));
  const savedHome = process.env.GEMINI_HOME;
  const savedKey = process.env.GEMINI_API_KEY;
  const originalKeychainPresent = keychain.present;
  let secretCalls = 0;
  process.env.GEMINI_HOME = home;
  delete process.env.GEMINI_API_KEY;
  keychain.present = async () => undefined;
  secretService.present = async () => { secretCalls++; return true; };
  try {
    const auth = await inspectAcpAuth();
    assert.equal(auth.status, "oauth-refreshable");
    assert.equal(auth.authType, "oauth-personal");
    assert.equal(auth.keyring, true);
    assert.equal(auth.tokenFile, false);
    assert.equal(auth.settingsFile, false);
    assert.equal(await authReady(), true);
    assert.ok(secretCalls > 0, "only the injected keyring runner may be probed");
    await assert.rejects(fs.access(path.join(home, "antigravity-acp", "acp_token.json")));
    assert.deepEqual(await fs.readdir(home), [], "the isolated store stays untouched");
    assert.equal(process.env.GEMINI_HOME, home);
    // An explicit auth type in the settings file survives the keyring fallback.
    await fs.mkdir(path.join(home, "antigravity-acp"), { recursive: true });
    await fs.writeFile(path.join(home, "antigravity-acp", "settings.json"),
      JSON.stringify({ auth: { type: "oauth-enterprise" } }));
    const typed = await inspectAcpAuth();
    assert.equal(typed.status, "oauth-refreshable");
    assert.equal(typed.authType, "oauth-enterprise");
    assert.equal(typed.settingsFile, true);
    assert.equal(typed.keyring, true);
  } finally {
    keychain.present = originalKeychainPresent;
    secretService.present = noSecretService;
    if (savedHome === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = savedHome;
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey;
    await fs.rm(home, { recursive: true, force: true });
  }
  assert.equal(process.env.GEMINI_HOME, savedHome);
  assert.equal(process.env.GEMINI_API_KEY, savedKey);
});

test("an absent keyring item stays missing and not ready", async () => {
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
    assert.equal(auth.tokenFile, false);
    assert.equal(await authReady(), false);
  } finally {
    keychain.present = originalKeychainPresent;
    secretService.present = noSecretService;
    if (savedHome === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = savedHome;
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey;
    await fs.rm(home, { recursive: true, force: true });
  }
  assert.equal(process.env.GEMINI_HOME, savedHome);
  assert.equal(process.env.GEMINI_API_KEY, savedKey);
});

test("api-key and token-file logins keep priority over the keyring", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-keyring-"));
  const savedHome = process.env.GEMINI_HOME;
  const savedKey = process.env.GEMINI_API_KEY;
  let secretCalls = 0;
  process.env.GEMINI_HOME = home;
  process.env.GEMINI_API_KEY = "synthetic-api-key";
  secretService.present = async () => { secretCalls++; return true; };
  try {
    const apiKey = await inspectAcpAuth();
    assert.equal(apiKey.status, "api-key-env");
    assert.equal(apiKey.authType, "gemini-api-key");
    assert.equal(apiKey.keyring, undefined);
    delete process.env.GEMINI_API_KEY;
    await fs.mkdir(path.join(home, "antigravity-acp"), { recursive: true });
    await fs.writeFile(path.join(home, "antigravity-acp", "acp_token.json"),
      JSON.stringify({ refresh_token: "synthetic-refresh-token" }));
    const file = await inspectAcpAuth();
    assert.equal(file.status, "oauth-refreshable");
    assert.equal(file.tokenFile, true);
    assert.equal(file.keyring, undefined);
    assert.equal(await authReady(), true);
    assert.equal(secretCalls, 0, "the keyring is only consulted when the file store is missing");
  } finally {
    secretService.present = noSecretService;
    if (savedHome === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = savedHome;
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey;
    await fs.rm(home, { recursive: true, force: true });
  }
  assert.equal(process.env.GEMINI_HOME, savedHome);
  assert.equal(process.env.GEMINI_API_KEY, savedKey);
});

test("fresh login clears a present keyring entry only after runtime shutdown", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-keyring-"));
  const savedHome = process.env.GEMINI_HOME;
  const originalKeychainApplicable = keychain.applicable;
  const originalKeychainPresent = keychain.present;
  const originalKeychainRemove = keychain.remove;
  const originalSecretApplicable = secretService.applicable;
  const originalSecretRemove = secretService.remove;
  const originalRetryMs = logoutFollow.removalRetryMs;
  const order: string[] = [];
  let present = true, keyringRemoves = 0, keychainRemoves = 0, closed = false;
  process.env.GEMINI_HOME = home;
  logoutFollow.removalRetryMs = 0;
  keychain.applicable = false;
  keychain.present = async () => undefined;
  keychain.remove = async () => { keychainRemoves++; return undefined; };
  secretService.applicable = true;
  secretService.present = async () => present;
  secretService.remove = async () => {
    assert.equal(closed, true, "adapter runtimes must exit before the keyring is cleared");
    keyringRemoves++;
    order.push("keyring-remove");
    present = false;
    return true;
  };
  try {
    const fixture = authCoordinatorFixture({
      logoutAllRuntimes: async () => { order.push("logout"); },
      closeAllRuntimes: async () => { order.push("close"); closed = true; },
    });
    const result = await fixture.coordinator.performCommandLogout(fixture.ctx);
    assert.equal(result.keyringRemoved, true);
    assert.equal(result.keychainRemoved, undefined, "the macOS keychain does not apply here");
    assert.equal(result.ompMarker, "absent");
    assert.equal(keyringRemoves, 1);
    assert.equal(keychainRemoves, 0);
    assert.ok(order.indexOf("logout") < order.indexOf("keyring-remove"), JSON.stringify(order));
    assert.ok(order.indexOf("close") < order.indexOf("keyring-remove"), JSON.stringify(order));
    // A second fresh login finds the entry gone and must not remove it again.
    await fixture.coordinator.beginFreshGoogleLogin();
    assert.equal(keyringRemoves, 1, "an absent keyring entry is not removed again");
  } finally {
    keychain.applicable = originalKeychainApplicable;
    keychain.present = originalKeychainPresent;
    keychain.remove = originalKeychainRemove;
    secretService.applicable = originalSecretApplicable;
    secretService.present = noSecretService;
    secretService.remove = originalSecretRemove;
    logoutFollow.removalRetryMs = originalRetryMs;
    if (savedHome === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = savedHome;
    await fs.rm(home, { recursive: true, force: true });
  }
  assert.equal(process.env.GEMINI_HOME, savedHome);
});

test("a keyring entry that survives removal refuses a fresh login", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-keyring-"));
  const savedHome = process.env.GEMINI_HOME;
  const originalKeychainPresent = keychain.present;
  const originalSecretRemove = secretService.remove;
  const originalRetryMs = logoutFollow.removalRetryMs;
  let removes = 0;
  process.env.GEMINI_HOME = home;
  logoutFollow.removalRetryMs = 0;
  keychain.present = async () => undefined;
  // The removal claims success but a dying server flushes the item back.
  secretService.present = async () => true;
  secretService.remove = async () => { removes++; return true; };
  try {
    const fixture = authCoordinatorFixture();
    const result = await fixture.coordinator.performCommandLogout(fixture.ctx);
    assert.equal(result.keyringRemoved, false, "a still-present entry must never certify removal");
    assert.ok(removes >= 2, "removal is verified across repeated attempts");
    const beforeLogin = removes;
    await assert.rejects(fixture.coordinator.beginFreshGoogleLogin(), (error: Error) => {
      assert.match(error.message, /Unable to confirm removal of the Antigravity/);
      assert.doesNotMatch(error.message, /synthetic|refresh_token|token=/);
      return true;
    });
    assert.ok(removes > beforeLogin, "the refused login re-checks instead of trusting the old result");
  } finally {
    keychain.present = originalKeychainPresent;
    secretService.present = noSecretService;
    secretService.remove = originalSecretRemove;
    logoutFollow.removalRetryMs = originalRetryMs;
    if (savedHome === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = savedHome;
    await fs.rm(home, { recursive: true, force: true });
  }
  assert.equal(process.env.GEMINI_HOME, savedHome);
});

test("a failing keyring removal cannot certify a fresh login", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-keyring-"));
  const savedHome = process.env.GEMINI_HOME;
  const originalKeychainPresent = keychain.present;
  const originalSecretRemove = secretService.remove;
  const originalRetryMs = logoutFollow.removalRetryMs;
  process.env.GEMINI_HOME = home;
  logoutFollow.removalRetryMs = 0;
  keychain.present = async () => undefined;
  secretService.present = async () => true;
  secretService.remove = async () => undefined;
  try {
    const fixture = authCoordinatorFixture();
    const result = await fixture.coordinator.performCommandLogout(fixture.ctx);
    assert.equal(result.keyringRemoved, false,
      "a known-present keyring that becomes unavailable must not certify removal");
    await assert.rejects(fixture.coordinator.beginFreshGoogleLogin(), (error: Error) => {
      assert.match(error.message, /Unable to (?:remove|confirm)/);
      assert.doesNotMatch(error.message, /synthetic|refresh_token|token=/);
      return true;
    });
  } finally {
    keychain.present = originalKeychainPresent;
    secretService.present = noSecretService;
    secretService.remove = originalSecretRemove;
    logoutFollow.removalRetryMs = originalRetryMs;
    if (savedHome === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = savedHome;
    await fs.rm(home, { recursive: true, force: true });
  }
  assert.equal(process.env.GEMINI_HOME, savedHome);
});

test("an unreachable Linux Secret Service refuses a fresh login", async () => {
  const originalKeychainApplicable = keychain.applicable;
  const originalKeychainPresent = keychain.present;
  const originalKeychainRemove = keychain.remove;
  const originalSecretApplicable = secretService.applicable;
  const originalSecretPresent = secretService.present;
  const originalSecretRemove = secretService.remove;
  const inapplicableKeychain = createKeychain(async () => undefined, "linux");
  const unreachable = createSecretService(async () => {
    throw Object.assign(new Error("synthetic unavailable Secret Service"), { code: "ENOENT" });
  }, "linux");
  keychain.applicable = inapplicableKeychain.applicable;
  keychain.present = inapplicableKeychain.present;
  keychain.remove = inapplicableKeychain.remove;
  secretService.applicable = unreachable.applicable;
  secretService.present = unreachable.present;
  secretService.remove = unreachable.remove;
  try {
    await withTempGeminiHome(async () => {
      const fixture = authCoordinatorFixture();
      assert.equal(await secretService.present(), undefined,
        "the Linux fixture is applicable but its keyring cannot be reached");
      await assert.rejects(fixture.coordinator.beginFreshGoogleLogin(),
        /Unable to confirm removal of the Antigravity credentials/);
    });
  } finally {
    keychain.applicable = originalKeychainApplicable;
    keychain.present = originalKeychainPresent;
    keychain.remove = originalKeychainRemove;
    secretService.applicable = originalSecretApplicable;
    secretService.present = originalSecretPresent;
    secretService.remove = originalSecretRemove;
  }
});

test("a fresh login ignores truly inapplicable credential stores", async () => {
  const originalKeychainApplicable = keychain.applicable;
  const originalKeychainPresent = keychain.present;
  const originalKeychainRemove = keychain.remove;
  const originalSecretApplicable = secretService.applicable;
  const originalSecretPresent = secretService.present;
  const originalSecretRemove = secretService.remove;
  let runnerCalls = 0;
  const unsupportedKeychain = createKeychain(async () => { runnerCalls++; }, "linux");
  const unsupportedSecretService = createSecretService(async () => { runnerCalls++; return ""; }, "darwin");
  keychain.applicable = unsupportedKeychain.applicable;
  keychain.present = unsupportedKeychain.present;
  keychain.remove = unsupportedKeychain.remove;
  secretService.applicable = unsupportedSecretService.applicable;
  secretService.present = unsupportedSecretService.present;
  secretService.remove = unsupportedSecretService.remove;
  try {
    await withTempGeminiHome(async () => {
      const fixture = authCoordinatorFixture();
      const attempt = await fixture.coordinator.beginFreshGoogleLogin();
      fixture.coordinator.cancelFreshGoogleLogin(attempt);
      assert.equal(fixture.logoutCallCount(), 1, "ordinary file cleanup still runs");
      assert.equal(runnerCalls, 0, "unsupported platform stores never execute their runners");
    });
  } finally {
    keychain.applicable = originalKeychainApplicable;
    keychain.present = originalKeychainPresent;
    keychain.remove = originalKeychainRemove;
    secretService.applicable = originalSecretApplicable;
    secretService.present = originalSecretPresent;
    secretService.remove = originalSecretRemove;
  }
});

test("the logout summary names the system keyring without exposing a token", () => {
  const both = formatLogoutSummary({ keychainRemoved: true, keyringRemoved: true, ompMarker: "removed" });
  assert.match(both,
    /Google credentials, saved ACP sessions, the macOS keychain entry, the system keyring entry and the OMP marker record cleared/);
  assert.doesNotMatch(both, /token|secret|refresh/i);
  assert.match(formatLogoutSummary({ keychainRemoved: undefined, keyringRemoved: false }),
    /The system keyring entry was not present or not removable/);
  assert.doesNotMatch(formatLogoutSummary({ keychainRemoved: false, keyringRemoved: undefined }),
    /system keyring/, "an inapplicable keyring stays out of the macOS summary");
});

test("the followed logout clears the keyring with the keychain and marker", async () => {
  const originalPresent = keychain.present;
  const originalRemove = keychain.remove;
  const originalSecretRemove = secretService.remove;
  const originalDelayMs = logoutFollow.delayMs;
  const originalRetryMs = logoutFollow.removalRetryMs;
  let keychainEntry = true, keychainRemoves = 0, keyringEntry = true, keyringRemoves = 0;
  keychain.present = async () => keychainEntry;
  keychain.remove = async () => { keychainRemoves++; keychainEntry = false; return true; };
  secretService.present = async () => keyringEntry;
  secretService.remove = async () => { keyringRemoves++; keyringEntry = false; return true; };
  logoutFollow.delayMs = 5;
  logoutFollow.removalRetryMs = 0;
  try {
    const fixture = authCoordinatorFixture();
    fixture.coordinator.watchOmpCredentials(fixture.ctx);
    fixture.storeMarker();
    fixture.removeMarker();
    await settle(40);
    const followed = fixture.followedNotices();
    assert.equal(followed.length, 1, "exactly one followed logout");
    assert.match(followed[0]!,
      /the macOS keychain entry and the system keyring entry cleared/);
    assert.equal(keychainRemoves, 1);
    assert.equal(keyringRemoves, 1);
    assert.equal(keychainEntry, false);
    assert.equal(keyringEntry, false);
    await settle(40);
    assert.equal(fixture.followedNotices().length, 1, "no duplicate follow-up logout");
  } finally {
    keychain.present = originalPresent;
    keychain.remove = originalRemove;
    secretService.present = noSecretService;
    secretService.remove = originalSecretRemove;
    logoutFollow.delayMs = originalDelayMs;
    logoutFollow.removalRetryMs = originalRetryMs;
  }
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

test("a stale marker removed during a fresh login schedules no followed logout", async () => {
  const originalPresent = keychain.present;
  const originalRemove = keychain.remove;
  const originalDelayMs = logoutFollow.delayMs;
  const originalRetryMs = logoutFollow.removalRetryMs;
  keychain.present = async () => false;
  keychain.remove = async () => true;
  logoutFollow.delayMs = 5;
  logoutFollow.removalRetryMs = 0;
  let releaseClose: () => void = () => {};
  const closing = new Promise<void>(resolve => { releaseClose = resolve; });
  try {
    await withTempGeminiHome(async () => {
      const fixture = authCoordinatorFixture({ closeAllRuntimes: () => closing });
      fixture.coordinator.watchOmpCredentials(fixture.ctx);
      fixture.storeMarker();
      const login = fixture.coordinator.beginFreshGoogleLogin();
      // OMP removes the stale marker while the browser sign-in is still running.
      fixture.removeMarker();
      await settle(30);
      assert.equal(fixture.logoutCallCount(), 0, "the stale marker removal must not finish a logout");
      assert.equal(fixture.followedNotices().length, 0);
      releaseClose();
      await login;
      assert.equal(fixture.logoutCallCount(), 1, "the fresh login logs out exactly once");
    });
  } finally {
    keychain.present = originalPresent;
    keychain.remove = originalRemove;
    logoutFollow.delayMs = originalDelayMs;
    logoutFollow.removalRetryMs = originalRetryMs;
  }
});

test("a stale marker removed while the sign-in runs schedules no followed logout", async () => {
  const originalPresent = keychain.present;
  const originalRemove = keychain.remove;
  const originalDelayMs = logoutFollow.delayMs;
  const originalRetryMs = logoutFollow.removalRetryMs;
  keychain.present = async () => false;
  keychain.remove = async () => true;
  logoutFollow.delayMs = 5;
  logoutFollow.removalRetryMs = 0;
  try {
    await withTempGeminiHome(async () => {
      const fixture = authCoordinatorFixture();
      fixture.coordinator.watchOmpCredentials(fixture.ctx);
      fixture.storeMarker();
      const attempt = await fixture.coordinator.beginFreshGoogleLogin();
      const baseline = fixture.logoutCallCount();
      // OMP drops the stale marker while the browser sign-in is still running.
      fixture.removeMarker();
      await settle(30);
      assert.equal(fixture.logoutCallCount(), baseline, "the sign-in must not be cancelled");
      assert.equal(fixture.followedNotices().length, 0);
      // The completed sign-in clears the suppression: a later explicit logout follows.
      fixture.coordinator.noteLoginSucceeded(attempt);
      fixture.storeMarker();
      fixture.removeMarker();
      await settle(30);
      assert.equal(fixture.logoutCallCount(), baseline + 1);
      assert.equal(fixture.followedNotices().length, 1);
    });
  } finally {
    keychain.present = originalPresent;
    keychain.remove = originalRemove;
    logoutFollow.delayMs = originalDelayMs;
    logoutFollow.removalRetryMs = originalRetryMs;
  }
});

test("cancel after command logout preserves the known absent marker without a watcher", async () => {
  const originalPresent = keychain.present;
  const originalRemove = keychain.remove;
  keychain.present = async () => false;
  keychain.remove = async () => true;
  const originalRetryMs = logoutFollow.removalRetryMs;
  logoutFollow.removalRetryMs = 0;
  try {
    await withTempGeminiHome(async () => {
      const fixture = authCoordinatorFixture({ watchableCredentials: false });
      fixture.coordinator.watchOmpCredentials(fixture.ctx);
      fixture.storeMarker();
      await fixture.coordinator.performCommandLogout(fixture.ctx);
      assert.equal(fixture.coordinator.apiKeyFallback, false);
      const attempt = await fixture.coordinator.beginFreshGoogleLogin();
      fixture.coordinator.cancelFreshGoogleLogin(attempt);
      assert.equal(fixture.coordinator.apiKeyFallback, false,
        "the command's own confirmed logout must survive a later cancelled login");
    });
  } finally {
    keychain.present = originalPresent;
    keychain.remove = originalRemove;
    logoutFollow.removalRetryMs = originalRetryMs;
  }
});

test("a soft-disable with a retained marker expires before a later real logout", async () => {
  const originalPresent = keychain.present;
  const originalRemove = keychain.remove;
  keychain.present = async () => false;
  keychain.remove = async () => true;
  const originalDelayMs = logoutFollow.delayMs;
  const originalDisabledMs = logoutFollow.disabledSuppressionMs;
  logoutFollow.delayMs = 5;
  logoutFollow.disabledSuppressionMs = 10;
  try {
    const fixture = authCoordinatorFixture();
    fixture.coordinator.watchOmpCredentials(fixture.ctx);
    fixture.storeMarker();
    fixture.emit("credential_disabled", { provider: "antigravity-acp" });
    await settle(20);
    fixture.removeMarker();
    await settle(30);
    assert.equal(fixture.coordinator.apiKeyFallback, false);
    assert.equal(fixture.followedNotices().length, 1,
      "an unrelated automatic disable must not permanently disable real logout handling");
  } finally {
    keychain.present = originalPresent;
    keychain.remove = originalRemove;
    logoutFollow.delayMs = originalDelayMs;
    logoutFollow.disabledSuppressionMs = originalDisabledMs;
  }
});

test("cancelling an external login permits a later real logout", async () => {
  const originalPresent = keychain.present;
  const originalRemove = keychain.remove;
  keychain.present = async () => false;
  keychain.remove = async () => true;
  const originalDelayMs = logoutFollow.delayMs;
  const originalRetryMs = logoutFollow.removalRetryMs;
  logoutFollow.delayMs = 5;
  logoutFollow.removalRetryMs = 0;
  try {
    await withTempGeminiHome(async () => {
      const fixture = authCoordinatorFixture();
      fixture.coordinator.watchOmpCredentials(fixture.ctx);
      fixture.storeMarker();
      const attempt = await fixture.coordinator.beginFreshGoogleLogin();
      fixture.coordinator.cancelFreshGoogleLogin(attempt);
      fixture.removeMarker();
      await settle(30);
      assert.equal(fixture.coordinator.apiKeyFallback, false);
      assert.equal(fixture.followedNotices().length, 1);
      assert.equal(fixture.logoutCallCount(), 2);
    });
  } finally {
    keychain.present = originalPresent;
    keychain.remove = originalRemove;
    logoutFollow.delayMs = originalDelayMs;
    logoutFollow.removalRetryMs = originalRetryMs;
  }
});

test("a stale login cancellation preserves the active attempt's suppression", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => { t.mock.timers.reset(); });
  const originalPresent = keychain.present;
  const originalRemove = keychain.remove;
  const originalDelayMs = logoutFollow.delayMs;
  const originalRetryMs = logoutFollow.removalRetryMs;
  keychain.present = async () => false;
  keychain.remove = async () => true;
  logoutFollow.delayMs = 5;
  logoutFollow.removalRetryMs = 0;
  let releaseSecondClose: () => void = () => {};
  const secondClosing = new Promise<void>(resolve => { releaseSecondClose = resolve; });
  let secondLogin: Promise<FreshGoogleLoginAttempt> | undefined;
  try {
    await withTempGeminiHome(async () => {
      let closeCalls = 0;
      const fixture = authCoordinatorFixture({
        closeAllRuntimes: async () => {
          closeCalls++;
          if (closeCalls === 2) await secondClosing;
        },
      });
      fixture.coordinator.watchOmpCredentials(fixture.ctx);
      fixture.storeMarker();
      // Attempt A finished preparing but its browser flow has not settled.
      const firstAttempt = await fixture.coordinator.beginFreshGoogleLogin();
      // Attempt B is now the active fresh login, waiting in its own teardown.
      secondLogin = fixture.coordinator.beginFreshGoogleLogin();
      // A late rejection from A must not cancel B's marker-removal suppression.
      fixture.coordinator.cancelFreshGoogleLogin(firstAttempt);
      fixture.removeMarker();
      for (let iteration = 0; iteration < 16; iteration++) {
        t.mock.timers.tick(1);
        await Promise.resolve();
      }
      assert.equal(fixture.logoutCallCount(), 1,
        "the stale cancellation must not start a followed logout during attempt B");
      assert.equal(fixture.followedNotices().length, 0);
      releaseSecondClose();
      await secondLogin;
      assert.equal(fixture.logoutCallCount(), 2, "attempt B still performs its own logout");
    });
  } finally {
    releaseSecondClose();
    await secondLogin?.catch(() => undefined);
    keychain.present = originalPresent;
    keychain.remove = originalRemove;
    logoutFollow.delayMs = originalDelayMs;
    logoutFollow.removalRetryMs = originalRetryMs;
  }
});

test("a stale login success and duplicate terminal preserve the active attempt's suppression", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => { t.mock.timers.reset(); });
  const originalPresent = keychain.present;
  const originalRemove = keychain.remove;
  const originalDelayMs = logoutFollow.delayMs;
  const originalRetryMs = logoutFollow.removalRetryMs;
  keychain.present = async () => false;
  keychain.remove = async () => true;
  logoutFollow.delayMs = 5;
  logoutFollow.removalRetryMs = 0;
  let releaseSecondClose: () => void = () => {};
  const secondClosing = new Promise<void>(resolve => { releaseSecondClose = resolve; });
  let secondLogin: Promise<FreshGoogleLoginAttempt> | undefined;
  try {
    await withTempGeminiHome(async () => {
      let closeCalls = 0;
      const fixture = authCoordinatorFixture({
        closeAllRuntimes: async () => {
          closeCalls++;
          if (closeCalls === 2) await secondClosing;
        },
      });
      fixture.coordinator.watchOmpCredentials(fixture.ctx);
      fixture.storeMarker();
      const firstAttempt = await fixture.coordinator.beginFreshGoogleLogin();
      secondLogin = fixture.coordinator.beginFreshGoogleLogin();
      fixture.coordinator.noteLoginSucceeded(firstAttempt);
      fixture.coordinator.cancelFreshGoogleLogin(firstAttempt);
      fixture.removeMarker();
      for (let iteration = 0; iteration < 16; iteration++) {
        t.mock.timers.tick(1);
        await Promise.resolve();
      }
      assert.equal(fixture.logoutCallCount(), 1,
        "late success and a duplicate terminal must not expose attempt B to a stale logout");
      assert.equal(fixture.followedNotices().length, 0);
      releaseSecondClose();
      const secondAttempt = await secondLogin;
      assert.equal(fixture.logoutCallCount(), 2, "attempt B still performs its own logout");
      fixture.coordinator.noteLoginSucceeded(secondAttempt);
      fixture.storeMarker();
      fixture.removeMarker();
      for (let iteration = 0; iteration < 16; iteration++) {
        t.mock.timers.tick(1);
        await Promise.resolve();
      }
      assert.equal(fixture.logoutCallCount(), 3, "the real final success re-enables later logout handling");
      assert.equal(fixture.followedNotices().length, 1);
    });
  } finally {
    releaseSecondClose();
    await secondLogin?.catch(() => undefined);
    keychain.present = originalPresent;
    keychain.remove = originalRemove;
    logoutFollow.delayMs = originalDelayMs;
    logoutFollow.removalRetryMs = originalRetryMs;
  }
});

test("a failed preparation keeps a newer attempt's flags intact", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => { t.mock.timers.reset(); });
  const originalPresent = keychain.present;
  const originalRemove = keychain.remove;
  const originalDelayMs = logoutFollow.delayMs;
  const originalRetryMs = logoutFollow.removalRetryMs;
  let failFirstPreparation = false;
  keychain.present = async () => {
    if (failFirstPreparation) throw new Error("synthetic first preparation failure");
    return false;
  };
  keychain.remove = async () => true;
  logoutFollow.delayMs = 5;
  logoutFollow.removalRetryMs = 0;
  let releaseFirstClose: () => void = () => {};
  const firstClosing = new Promise<void>(resolve => { releaseFirstClose = resolve; });
  let firstLogin: Promise<FreshGoogleLoginAttempt> | undefined;
  let secondLogin: Promise<FreshGoogleLoginAttempt> | undefined;
  try {
    await withTempGeminiHome(async () => {
      let closeCalls = 0;
      const fixture = authCoordinatorFixture({
        closeAllRuntimes: async () => {
          closeCalls++;
          if (closeCalls === 1) await firstClosing;
        },
      });
      fixture.coordinator.watchOmpCredentials(fixture.ctx);
      fixture.storeMarker();
      firstLogin = fixture.coordinator.beginFreshGoogleLogin();
      for (let iteration = 0; iteration < 64 && closeCalls !== 1; iteration++) {
        t.mock.timers.tick(1);
        await Promise.resolve();
      }
      assert.equal(closeCalls, 1, "attempt A is inside preparation");
      secondLogin = fixture.coordinator.beginFreshGoogleLogin();
      const secondAttempt = await secondLogin;
      failFirstPreparation = true;
      releaseFirstClose();
      await assert.rejects(firstLogin!, /synthetic first preparation failure/);
      fixture.removeMarker();
      for (let iteration = 0; iteration < 16; iteration++) {
        t.mock.timers.tick(1);
        await Promise.resolve();
      }
      assert.equal(fixture.logoutCallCount(), 2,
        "the failed older preparation must leave only the two begin logouts");
      assert.equal(fixture.followedNotices().length, 0);
      fixture.coordinator.noteLoginSucceeded(secondAttempt);
    });
  } finally {
    failFirstPreparation = false;
    releaseFirstClose();
    await firstLogin?.catch(() => undefined);
    await secondLogin?.catch(() => undefined);
    keychain.present = originalPresent;
    keychain.remove = originalRemove;
    logoutFollow.delayMs = originalDelayMs;
    logoutFollow.removalRetryMs = originalRetryMs;
  }
});

test("an earlier success prevents a later cancellation from restoring stale suppression", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => { t.mock.timers.reset(); });
  const originalPresent = keychain.present;
  const originalRemove = keychain.remove;
  const originalDelayMs = logoutFollow.delayMs;
  const originalRetryMs = logoutFollow.removalRetryMs;
  keychain.present = async () => false;
  keychain.remove = async () => true;
  logoutFollow.delayMs = 5;
  logoutFollow.removalRetryMs = 0;
  try {
    await withTempGeminiHome(async () => {
      const fixture = authCoordinatorFixture();
      fixture.coordinator.watchOmpCredentials(fixture.ctx);
      fixture.storeMarker();
      fixture.emit("credential_disabled", { provider: "antigravity-acp" });
      const firstAttempt = await fixture.coordinator.beginFreshGoogleLogin();
      const secondAttempt = await fixture.coordinator.beginFreshGoogleLogin();
      fixture.coordinator.noteLoginSucceeded(firstAttempt);
      fixture.coordinator.cancelFreshGoogleLogin(secondAttempt);
      fixture.removeMarker();
      for (let iteration = 0; iteration < 16; iteration++) {
        t.mock.timers.tick(1);
        await Promise.resolve();
      }
      assert.equal(fixture.logoutCallCount(), 3,
        "success followed by cancellation must not restore the pre-login suppression");
      assert.equal(fixture.followedNotices().length, 1);
    });
  } finally {
    keychain.present = originalPresent;
    keychain.remove = originalRemove;
    logoutFollow.delayMs = originalDelayMs;
    logoutFollow.removalRetryMs = originalRetryMs;
  }
});

test("an earlier success prevents a later preparation failure from restoring stale suppression", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => { t.mock.timers.reset(); });
  const originalPresent = keychain.present;
  const originalRemove = keychain.remove;
  const originalDelayMs = logoutFollow.delayMs;
  const originalRetryMs = logoutFollow.removalRetryMs;
  let failSecondPreparation = false;
  keychain.present = async () => {
    if (failSecondPreparation) throw new Error("synthetic second preparation failure");
    return false;
  };
  keychain.remove = async () => true;
  logoutFollow.delayMs = 5;
  logoutFollow.removalRetryMs = 0;
  let releaseSecondClose: () => void = () => {};
  const secondClosing = new Promise<void>(resolve => { releaseSecondClose = resolve; });
  let secondLogin: Promise<FreshGoogleLoginAttempt> | undefined;
  try {
    await withTempGeminiHome(async () => {
      let closeCalls = 0;
      const fixture = authCoordinatorFixture({
        closeAllRuntimes: async () => {
          closeCalls++;
          if (closeCalls === 2) await secondClosing;
        },
      });
      fixture.coordinator.watchOmpCredentials(fixture.ctx);
      fixture.storeMarker();
      fixture.emit("credential_disabled", { provider: "antigravity-acp" });
      const firstAttempt = await fixture.coordinator.beginFreshGoogleLogin();
      secondLogin = fixture.coordinator.beginFreshGoogleLogin();
      for (let iteration = 0; iteration < 64 && closeCalls !== 2; iteration++) {
        t.mock.timers.tick(1);
        await Promise.resolve();
      }
      assert.equal(closeCalls, 2, "attempt B is inside preparation");
      fixture.coordinator.noteLoginSucceeded(firstAttempt);
      failSecondPreparation = true;
      releaseSecondClose();
      await assert.rejects(secondLogin!, /synthetic second preparation failure/);
      failSecondPreparation = false;
      fixture.removeMarker();
      for (let iteration = 0; iteration < 16; iteration++) {
        t.mock.timers.tick(1);
        await Promise.resolve();
      }
      assert.equal(fixture.logoutCallCount(), 3,
        "success followed by failed preparation must not restore the pre-login suppression");
      assert.equal(fixture.followedNotices().length, 1);
    });
  } finally {
    failSecondPreparation = false;
    releaseSecondClose();
    await secondLogin?.catch(() => undefined);
    keychain.present = originalPresent;
    keychain.remove = originalRemove;
    logoutFollow.delayMs = originalDelayMs;
    logoutFollow.removalRetryMs = originalRetryMs;
  }
});

test("a refused fresh login restores suppression so a later logout still follows", async () => {
  const originalPresent = keychain.present;
  const originalRemove = keychain.remove;
  const originalDelayMs = logoutFollow.delayMs;
  const originalRetryMs = logoutFollow.removalRetryMs;
  let entry = true;
  let failing = true;
  keychain.present = async () => entry;
  keychain.remove = async () => {
    if (failing) throw new Error("Unable to remove the Antigravity keychain entry");
    entry = false;
    return true;
  };
  logoutFollow.delayMs = 5;
  logoutFollow.removalRetryMs = 0;
  try {
    await withTempGeminiHome(async () => {
      const fixture = authCoordinatorFixture();
      fixture.coordinator.watchOmpCredentials(fixture.ctx);
      fixture.storeMarker();
      await assert.rejects(fixture.coordinator.beginFreshGoogleLogin(),
        /Unable to remove the Antigravity keychain entry/);
      assert.equal(fixture.logoutCallCount(), 1, "the refused login still tore down the runtimes");
      // An explicit OMP logout after the refused login must still be followed.
      failing = false;
      fixture.removeMarker();
      await settle(30);
      assert.equal(fixture.logoutCallCount(), 2);
      assert.equal(entry, false, "the followed logout cleared the keychain entry");
      assert.equal(fixture.followedNotices().length, 1);
    });
  } finally {
    keychain.present = originalPresent;
    keychain.remove = originalRemove;
    logoutFollow.delayMs = originalDelayMs;
    logoutFollow.removalRetryMs = originalRetryMs;
  }
});

test("a refused fresh login keeps an unrelated suppression instead of clearing it", async () => {
  const originalPresent = keychain.present;
  const originalRemove = keychain.remove;
  const originalDelayMs = logoutFollow.delayMs;
  const originalRetryMs = logoutFollow.removalRetryMs;
  keychain.present = async () => true;
  keychain.remove = async () => undefined;
  logoutFollow.delayMs = 5;
  logoutFollow.removalRetryMs = 0;
  try {
    await withTempGeminiHome(async () => {
      const fixture = authCoordinatorFixture();
      fixture.coordinator.watchOmpCredentials(fixture.ctx);
      fixture.storeMarker();
      // OMP soft-disabled the provider (for example invalid_grant) before the login.
      fixture.emit("credential_disabled", { provider: "antigravity-acp" });
      await assert.rejects(fixture.coordinator.beginFreshGoogleLogin(),
        /Unable to confirm removal of the Antigravity credentials/);
      fixture.removeMarker();
      await settle(30);
      assert.equal(fixture.followedNotices().length, 0,
        "a blanket reset would erase the pre-existing suppression");
      assert.equal(fixture.logoutCallCount(), 1);
      // That suppression is single-use; the next explicit logout is followed.
      fixture.storeMarker();
      fixture.removeMarker();
      await settle(30);
      assert.equal(fixture.logoutCallCount(), 2);
      assert.equal(fixture.followedNotices().length, 1);
    });
  } finally {
    keychain.present = originalPresent;
    keychain.remove = originalRemove;
    logoutFollow.delayMs = originalDelayMs;
    logoutFollow.removalRetryMs = originalRetryMs;
  }
});
