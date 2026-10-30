// Offline auth command integration test; requires Bun but never launches ACP,
// never touches the real ~/.gemini directory, OMP state or the macOS keychain.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerOmpAdapter, keychain, logoutFollow } from "../extension/index.ts";
import { AntigravityRuntime } from "../extension/runtime.mjs";
import { SessionRuntimePool } from "../extension/runtime-pool.ts";

const MARKER = "pi-antigravity-acp:managed-by-antigravity";
const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-command-"));
const geminiHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-gemini-"));
// Isolate every Antigravity-owned path the handlers touch.
process.env.GEMINI_HOME = geminiHome;
// A local executable makes ensureAntigravityAcpReady resolve offline; the
// loginGoogle prototype stub below keeps it from ever being spawned.
process.env.AGY_ACP_BIN = process.execPath;
const originalPresent = keychain.present;
const originalRemove = keychain.remove;
const originalLoginGoogle = AntigravityRuntime.prototype.loginGoogle;
const originalPoolValues = SessionRuntimePool.prototype.values;
const originalDelayMs = logoutFollow.delayMs;
const originalRetryMs = logoutFollow.retryMs;
logoutFollow.delayMs = 10;
logoutFollow.retryMs = 20;
const keychainCalls: string[] = [];
const hooks = new Map<string, Function>();
let command: any;
try {
  let keychainEntry = true;
  let flushOnce = false;
  keychain.present = async () => { keychainCalls.push("present"); return keychainEntry; };
  keychain.remove = async () => {
    keychainCalls.push("remove");
    if (!keychainEntry) return false;
    keychainEntry = false;
    if (flushOnce) { flushOnce = false; setTimeout(() => { keychainEntry = true; }, 100); }
    return true;
  };
  const registrations: boolean[] = [];
  await registerOmpAdapter({
    on(name: string, handler: Function) { hooks.set(name, handler); },
    registerProvider(_name: string, config: any) { registrations.push(Boolean(config?.apiKey)); }, registerTool() {},
    registerCommand(_name: string, registered: any) { command = registered; },
  }, stateDir);
  // A fresh profile keeps the non-secret config fallback so the catalog lists.
  assert.deepEqual(registrations, [true]);

  const notices: string[] = [];
  const inputs: { message: string; placeholder?: string }[] = [];
  const ompCredentials = new Map<string, any>();
  let refreshCalls = 0;
  const baseContext = {
    ui: { notify: (text: string) => notices.push(text), input: async (message: string, placeholder?: string) => { inputs.push({ message, placeholder }); return "http://127.0.0.1:45678/?state=abc&code=xyz"; } },
    sessionManager: { getSessionId: () => "fixture" },
  };
  const context = { ...baseContext, modelRegistry: {
    authStorage: {
      credentials: (() => {
        const generationListeners: (() => void)[] = [];
        return {
          getOAuth: (provider: string) => ompCredentials.get(provider),
          remove: async (provider: string) => { ompCredentials.delete(provider); for (const listener of generationListeners) listener(); },
          onGeneration: (listener: () => void) => { generationListeners.push(listener); return () => {}; },
          generationListeners,
        };
      })(),
      keys: { describe: () => "local store (oauth marker)" },
    },
    refreshProvider: async () => { refreshCalls++; },
  } };
  ompCredentials.set("antigravity-acp", { type: "oauth", refresh: MARKER, access: MARKER, expires: Number.MAX_SAFE_INTEGER, authorizedAt: 1234567890123, email: "marker@example.com" });
  const sessionRecord = {
    piSessionId: "018f24e1-7cbb-7000-8000-000000000001", acpSessionId: "018f24e1-7cbb-7000-8000-000000000002",
    acpModelId: "gemini-3.8-flash", cwd: stateDir, messageCount: 2, historyFingerprint: "f".repeat(64),
    expectedAssistantFingerprint: "a".repeat(64), lastActive: Date.now(),
  };
  await fs.writeFile(path.join(stateDir, "sessions.json"), JSON.stringify([sessionRecord], null, 2));

  // account: read-only view over OMP marker, isolated ACP state and keychain.
  await command.handler("account", context);
  const account = notices.pop();
  assert.match(account, /Antigravity ACP account/);
  assert.match(account, /Google account: signed in \(token in macOS keychain; email not read\)/);
  assert.match(account, /Authentication: missing/);
  assert.match(account, /Credential storage \(preflight\): server default \(expected: no refreshable token file to reuse\)/);
  assert.match(account, /OMP marker record: present, authorized 2009-02-13T23:31:30\.123Z as marker@example\.com \(non-secret managed marker\)/);
  assert.match(account, /OMP auth source: local store \(oauth marker\)/);
  assert.match(account, /Saved ACP sessions: 1/);
  assert.match(account, /Requested permission mode: yolo/);
  assert.match(account, /Active bindings: 0/);
  await assert.rejects(command.handler("account extra", context), /Usage:/);

  // A stored id_token file provides the account email without keychain access.
  const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  await fs.mkdir(path.join(geminiHome, "antigravity-acp"), { recursive: true });
  await fs.writeFile(path.join(geminiHome, "antigravity-acp", "acp_token.json"),
    JSON.stringify({ id_token: `${b64url({ alg: "RS256" })}.${b64url({ email: "acp-file@example.com" })}.sig` }));
  await command.handler("account", context);
  assert.match(notices.pop(), /Google account: acp-file@example\.com/);

  // login: upstream OAuth flow stubbed at loginGoogle; the command must map
  // OMP dialogs onto the upstream interaction and return the pasted callback.
  const loginSeen: { pasted?: string } = {};
  AntigravityRuntime.prototype.loginGoogle = async function (_signal: any, onProgress: any, manual: any) {
    onProgress?.("Stub login progress");
    manual.showAuthorizationUrl("https://accounts.google.com/o/oauth2/v2/auth?scope=test", "Open the authorization URL");
    loginSeen.pasted = await manual.promptForCallback();
  } as any;
  // A stale token file must be cleared so the login cannot reuse the old account.
  await fs.mkdir(path.join(geminiHome, "antigravity-acp"), { recursive: true });
  await fs.writeFile(path.join(geminiHome, "antigravity-acp", "acp_token.json"), JSON.stringify({ refresh_token: "stale" }));
  await command.handler("login", context);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].message, "Paste the final localhost callback URL (or authorization code):");
  assert.equal(inputs[0].placeholder, "http://127.0.0.1:PORT/?state=…&code=…");
  assert.equal(loginSeen.pasted, "http://127.0.0.1:45678/?state=abc&code=xyz");
  const loginNotice = notices.join("\n");
  assert.ok(loginNotice.includes("Stub login progress"));
  assert.ok(loginNotice.includes("https://accounts.google.com/o/oauth2/v2/auth?scope=test"));
  assert.ok(loginNotice.includes("Antigravity Google login finished — fresh sign-in"), notices.join(" | "));
  assert.ok(loginNotice.includes("fresh sign-in"), notices.join(" | "));
  await assert.rejects(fs.access(path.join(geminiHome, "antigravity-acp", "acp_token.json")));
  await assert.rejects(fs.access(path.join(stateDir, "sessions.json")),
    "Fresh login must not restore ACP mappings owned by the previous Google account");
  assert.equal(JSON.parse(await fs.readFile(path.join(geminiHome, "antigravity-acp", "settings.json"), "utf8").catch(() => "{}")).auth, undefined);
  assert.ok(keychainCalls.includes("remove"), "Login must clear stored credentials for a fresh sign-in");
  // login must refuse while an Antigravity request is active.
  SessionRuntimePool.prototype.values = function () { return [{ isBusy: () => true }]; } as any;
  await assert.rejects(command.handler("login", context), /Wait for active Antigravity requests/);
  SessionRuntimePool.prototype.values = originalPoolValues;
  await assert.rejects(command.handler("login extra", context), /Usage:/);

  // logout with active work must refuse rather than tear down live sessions.
  SessionRuntimePool.prototype.values = function () { return [{ isBusy: () => true }]; } as any;
  await assert.rejects(command.handler("logout", context), /Wait for active Antigravity requests/);
  SessionRuntimePool.prototype.values = originalPoolValues;
  assert.ok(ompCredentials.has("antigravity-acp"), "Refused logout must keep the OMP marker");

  // logout: real upstream runtime.logout() against isolated directories.
  await fs.writeFile(path.join(geminiHome, "antigravity-acp", "acp_token.json"), JSON.stringify({ refresh_token: "secret-ref" }));
  await command.handler("logout", context);
  const logoutNotice = notices.pop();
  assert.match(logoutNotice, /Antigravity ACP: logged out — Google credentials, saved ACP sessions, the macOS keychain entry and the OMP marker record cleared/);
  assert.equal(registrations[registrations.length - 1], false, "Logout must drop the config apiKey fallback");
  assert.equal(refreshCalls, 1, "Logout must refresh the provider after removing the marker");
  await assert.rejects(fs.access(path.join(stateDir, "sessions.json")));
  await assert.rejects(fs.access(path.join(geminiHome, "antigravity-acp", "acp_token.json")));
  assert.equal(JSON.parse(await fs.readFile(path.join(geminiHome, "antigravity-acp", "settings.json"), "utf8").catch(() => "{}")).auth, undefined);
  assert.equal(ompCredentials.size, 0);
  // The keychain stub mirrors the removed ACP item after logout.
  // The next request must build a fresh runtime pool entry, not the closed one.
  await command.handler("account", context);
  const afterLogout = notices.pop();
  assert.match(afterLogout, /Google account: not signed in/);
  assert.match(afterLogout, /Authentication: missing/);
  assert.match(afterLogout, /OMP marker record: not stored; run \/login or \/antigravity-acp login/);
  assert.match(afterLogout, /Saved ACP sessions: 0/);
  await assert.rejects(command.handler("logout extra", context), /Usage:/);

  // logout without a model registry reports the manual /logout fallback.
  await command.handler("logout", baseContext);
  const fallbackNotice = notices.pop();
  assert.match(fallbackNotice, /logged out — Google credentials, saved ACP sessions and the macOS keychain entry cleared\. The OMP marker record could not be removed; run \/logout to drop it\./);

  const credentialStore = context.modelRegistry.authStorage.credentials;
  const followNotices = () => notices.filter(n => n.includes("finished the logout OMP started"));
  const settle = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
  const storeMarker = () => {
    ompCredentials.set("antigravity-acp", { type: "oauth", refresh: MARKER, access: MARKER, expires: Number.MAX_SAFE_INTEGER, authorizedAt: Date.now() });
    for (const listener of credentialStore.generationListeners) listener();
  };

  // The manual command removed the marker itself; the follow-up must stay silent.
  await settle();
  assert.equal(followNotices().length, 0, "Manual logout must not trigger the followed logout");

  // OMP /logout removing the marker finishes the Antigravity-side logout.
  // The keychain stub simulates a dying server flushing its token back once;
  // the durable removal must retry past it.
  await fs.writeFile(path.join(geminiHome, "antigravity-acp", "acp_token.json"), JSON.stringify({ refresh_token: "secret-ref" }));
  await fs.writeFile(path.join(stateDir, "sessions.json"), JSON.stringify([sessionRecord], null, 2));
  keychainEntry = true;
  flushOnce = true;
  storeMarker();
  assert.equal(registrations[registrations.length - 1], true, "A stored marker restores the config apiKey fallback");
  await credentialStore.remove("antigravity-acp");
  assert.equal(registrations[registrations.length - 1], false, "Marker removal must drop the fallback in the same tick");
  await settle(1500);
  const followed = followNotices();
  assert.equal(followed.length, 1, "OMP-side marker removal must trigger the followed logout");
  assert.match(followed[0], /Antigravity ACP: finished the logout OMP started — Google credentials, saved ACP sessions and the macOS keychain entry cleared/);
  assert.equal(keychainEntry, false, "The flushed-back keychain entry must be removed again");
  await assert.rejects(fs.access(path.join(geminiHome, "antigravity-acp", "acp_token.json")));
  await assert.rejects(fs.access(path.join(stateDir, "sessions.json")));

  // Automatic soft-disables (credential_disabled) must not destroy the login.
  storeMarker();
  await fs.writeFile(path.join(geminiHome, "antigravity-acp", "acp_token.json"), JSON.stringify({ refresh_token: "secret-ref" }));
  const removePromise = credentialStore.remove("antigravity-acp");
  hooks.get("credential_disabled")?.({ type: "credential_disabled", provider: "antigravity-acp", disabledCause: "oauth refresh failed" });
  await removePromise;
  await settle();
  assert.equal(followNotices().length, 1, "Automatic credential disables must not trigger the followed logout");

  // A quick re-login after removal cancels the cleanup.
  storeMarker();
  const quickRelogin = credentialStore.remove("antigravity-acp");
  storeMarker();
  await quickRelogin;
  assert.equal(registrations[registrations.length - 1], true, "A quick re-login restores the fallback");
  await settle();
  assert.equal(followNotices().length, 1, "A quick re-login must cancel the followed logout");


  // Command-driven /antigravity-acp login after a logout cancels any pending
  // followed logout and restores the config apiKey fallback.
  storeMarker();
  const pendingRemove = credentialStore.remove("antigravity-acp");
  await pendingRemove;
  assert.equal(registrations[registrations.length - 1], false);
  await command.handler("login", context);
  assert.equal(registrations[registrations.length - 1], true, "Command login must restore the config apiKey fallback");
  await settle();
  assert.equal(followNotices().length, 1, "Command login must cancel any pending followed logout");
  // OMP_ACP_FOLLOW_LOGOUT=0 keeps OMP /logout marker-only.
  process.env.OMP_ACP_FOLLOW_LOGOUT = "0";
  storeMarker();
  await credentialStore.remove("antigravity-acp");
  await settle();
  assert.equal(followNotices().length, 1, "The follow behavior must respect OMP_ACP_FOLLOW_LOGOUT=0");
  delete process.env.OMP_ACP_FOLLOW_LOGOUT;

  // Active requests defer the followed logout until the pool is idle again.
  storeMarker();
  SessionRuntimePool.prototype.values = function () { return [{ isBusy: () => true }]; } as any;
  await credentialStore.remove("antigravity-acp");
  await settle();
  assert.equal(followNotices().length, 1, "A busy pool must defer the followed logout");
  SessionRuntimePool.prototype.values = originalPoolValues;
  await settle(120);
  assert.equal(followNotices().length, 2, "The deferred followed logout must run once the pool is idle");
  console.log("Account view, login dialog mapping, logout isolation, busy guard and OMP-logout following: PASS");
} finally {
  keychain.present = originalPresent;
  keychain.remove = originalRemove;
  AntigravityRuntime.prototype.loginGoogle = originalLoginGoogle;
  SessionRuntimePool.prototype.values = originalPoolValues;
  logoutFollow.delayMs = originalDelayMs;
  logoutFollow.retryMs = originalRetryMs;
  await hooks.get("session_shutdown")?.({}, {});
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.rm(geminiHome, { recursive: true, force: true });
}
