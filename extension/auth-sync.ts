import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { clearAntigravityCredentials, inspectAntigravityAuth, resolveAntigravityAcpDirectory } from "./runtime.mjs";
import type { AntigravityAuthHealth } from "./runtime/acp/antigravity.ts";
import { createSecretService, runSecretTool } from "./secret-service.ts";
import type { TierConnection } from "./tier-connection.ts";

export const MARKER = "pi-antigravity-acp:managed-by-antigravity";

const execFileAsync = promisify(execFile);

// The real /usr/bin/security subprocess boundary, with its own binary
// parameter so tests can drive a stub executable through the same code path.
// Captured stderr is matched in memory only; it is never logged or persisted.
export function runSecurity(args: string[], bin = "/usr/bin/security"): Promise<void> {
  return execFileAsync(bin, args, { timeout: 3000 }).then(() => undefined);
}

// errSecItemNotFound reaches the caller as exit code 44 (OSStatus -25300
// truncated to 8 bits). The stderr wording separates it from any other
// OSStatus whose truncated code also lands on 44.
function isConfirmedMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const detail = error as { killed?: unknown; signal?: unknown; code?: unknown; stderr?: unknown };
  return detail.killed !== true && detail.signal == null && detail.code === 44
    && typeof detail.stderr === "string" && /could not be found/.test(detail.stderr);
}

export const KEYCHAIN_SERVICE = "gemini";
// The managed runtime stores the token under `antigravity-acp`; the agy CLI
// stores it under `antigravity`. Both are local logins, and logout must clear
// whichever entry the active channel wrote.
export const KEYCHAIN_ACCOUNTS = ["antigravity-acp", "antigravity"] as const;

// macOS keychain operations behind one mutable object so offline command
// tests can substitute them without touching the user's real keychain.
export function createKeychain(run: (args: string[]) => Promise<void>, platform: NodeJS.Platform = process.platform) {
  const check = async (args: string[], failure: string): Promise<boolean | undefined> => {
    if (platform !== "darwin") return undefined;
    try {
      await run(args);
      return true;
    } catch (error) {
      if (isConfirmedMissing(error)) return false;
      throw new Error(failure);
    }
  };
  const argsFor = (command: "find-generic-password" | "delete-generic-password", account: string): string[] =>
    [command, "-s", KEYCHAIN_SERVICE, "-a", account];
  const present = async (): Promise<boolean | undefined> => {
    if (platform !== "darwin") return undefined;
    for (const account of KEYCHAIN_ACCOUNTS) {
      if (await check(argsFor("find-generic-password", account), "Unable to inspect the Antigravity keychain entry")) return true;
    }
    return false;
  };
  const remove = async (): Promise<boolean | undefined> => {
    if (platform !== "darwin") return undefined;
    let removed = false;
    for (const account of KEYCHAIN_ACCOUNTS) {
      if (await check(argsFor("delete-generic-password", account), "Unable to remove the Antigravity keychain entry")) removed = true;
    }
    return removed;
  };
  return {
    applicable: platform === "darwin",
    // Check existence only: the item's ACL does not authorize the security
    // CLI, so a `find-generic-password -w` would pop the macOS keychain
    // password dialog. Attribute-only lookups stay prompt-free.
    present,
    // Both accounts are cleared so a
    // later channel switch cannot revive the previous login.
    remove,
  };
}

export const keychain = createKeychain(runSecurity);

// The Linux Secret Service item behind the same mutable boundary as the macOS
// keychain, so offline command tests never reach the user's real keyring.
export const secretService = createSecretService(runSecretTool);

function emailFromTokenJson(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { id_token?: unknown } | null;
    const idToken = parsed?.id_token;
    if (typeof idToken !== "string" || !idToken.includes(".")) return undefined;
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1]!, "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" && claims.email.includes("@") ? claims.email : undefined;
  } catch { return undefined; }
}

// The signed-in Google account, from the ACP server's token file only.
// Keychain-stored tokens report no email: reading the macOS keychain secret
// would require the account password on every call, so that path is removed.
export function antigravityAccountEmail(): string | undefined {
  try {
    return emailFromTokenJson(fs.readFileSync(path.join(resolveAntigravityAcpDirectory(), "acp_token.json"), "utf8"));
  } catch { /* no token file */ }
  return undefined;
}

// Timing knobs for following OMP-side logouts; mutable so offline tests can
// run the delayed detection and the removal verification without real waits.
export const logoutFollow = {
  delayMs: 500, retryMs: 15_000, removalRetryMs: 400, disabledSuppressionMs: 30_000,
};

// Shared wording for both logout confirmations (direct command and the
// follow-up that finishes a logout OMP started).
export function formatLogoutSummary(options: {
  keychainRemoved: boolean | undefined;
  keyringRemoved: boolean | undefined;
  ompMarker?: "removed" | "absent" | "unavailable";
  followed?: boolean;
}): string {
  const cleared = ["Google credentials", "saved ACP sessions"];
  if (options.keychainRemoved === true) cleared.push("the macOS keychain entry");
  if (options.keyringRemoved === true) cleared.push("the system keyring entry");
  if (options.ompMarker === "removed") cleared.push("the OMP marker record");
  const list = cleared.slice(0, -1).join(", ") + " and " + cleared[cleared.length - 1];
  return `${options.followed ? "Antigravity ACP: finished the logout OMP started — " : "Antigravity ACP: logged out — "}${list} cleared.` +
    (options.ompMarker === "unavailable" ? " The OMP marker record could not be removed; run /logout to drop it." : "") +
    (options.keychainRemoved === false ? " The macOS keychain entry was not present or not removable." : "") +
    (options.keyringRemoved === false ? " The system keyring entry was not present or not removable." : "");
}

// ACP auth health plus the Linux Secret Service fallback. The ACP server reads
// the system keyring before its file store, so a present keyring item is a
// complete local login even when no acp_token.json exists. A keyring probe that
// cannot reach the service (undefined) leaves the file-based health untouched:
// it is neither a stored credential nor a confirmed absence.
export interface AcpAuthHealth extends AntigravityAuthHealth {
  keyring?: boolean;
}

interface RawAuthHealth {
  status?: unknown;
  authType?: unknown;
  tokenFile?: unknown;
  settingsFile?: unknown;
}

function authStatusOf(value: unknown): AntigravityAuthHealth["status"] | undefined {
  switch (value) {
    case "api-key-env":
    case "oauth-refreshable":
    case "configured-not-authenticated":
    case "corrupt":
    case "missing":
      return value;
    default:
      return undefined;
  }
}

export async function inspectAcpAuth(directory?: string, env: NodeJS.ProcessEnv = process.env): Promise<AcpAuthHealth> {
  // The directory and the credential environment must describe the same child
  // process: an explicit GEMINI_HOME relocates both the token file and the store.
  const base: RawAuthHealth = inspectAntigravityAuth(directory ?? resolveAntigravityAcpDirectory(env), env);
  const status = authStatusOf(base.status);
  if (!status) throw new Error("Unable to inspect the Antigravity credential store");
  const health: AcpAuthHealth = {
    status,
    tokenFile: base.tokenFile === true,
    settingsFile: base.settingsFile === true,
    ...(typeof base.authType === "string" ? { authType: base.authType } : {}),
  };
  // An API key or a refreshable token file is a complete login on its own; the
  // keyring is only consulted when the file store reports no credential.
  if (status !== "missing" && status !== "configured-not-authenticated") return health;
  if ((await secretService.present()) !== true) return health;
  return { ...health, status: "oauth-refreshable", authType: health.authType ?? "oauth-personal", keyring: true };
}

export async function authReady(options: { allowKeychain?: boolean } = {}): Promise<boolean> {
  const health = await inspectAcpAuth();
  if (health.status === "api-key-env" || health.status === "oauth-refreshable") return true;
  if (options.allowKeychain === false) return false;
  return (await keychain.present()) === true;
}

export interface OmpCommandContext {
  ui: {
    notify: (text: string, level?: string) => void;
    input?: (message: string, placeholder?: string) => Promise<string | undefined>;
    select?: (title: string, options: string[]) => Promise<string>;
  };
  sessionManager?: {
    getSessionId?: () => string | undefined;
    getSessionFile?: () => string | undefined;
  };
  modelRegistry?: {
    refreshProvider?: (provider: string, mode?: string) => Promise<void>;
    authStorage?: {
      credentials?: {
        getOAuth?: (provider: string) => { refresh?: string; email?: string; authorizedAt?: number } | undefined;
        remove?: (provider: string) => Promise<void>;
        onGeneration?: (listener: () => void) => () => void;
      };
      keys?: {
        describe?: (provider: string, sessionId?: string) => string | undefined;
      };
    };
  };
}

// OMP stores only the non-secret marker credential. Read it defensively:
// the model registry surface is host version dependent and absent in tests.
export function ompCredentialSummary(ctx: OmpCommandContext | undefined) {
  try {
    const stored = ctx?.modelRegistry?.authStorage?.credentials?.getOAuth?.("antigravity-acp");
    if (!stored) return { present: false };
    return {
      present: true,
      record: stored.refresh === MARKER ? "non-secret managed marker" : "oauth credential",
      email: typeof stored.email === "string" && stored.email ? stored.email : undefined,
      authorizedAt: typeof stored.authorizedAt === "number" ? new Date(stored.authorizedAt).toISOString() : undefined,
    };
  } catch (error: unknown) {
    return { present: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

// Removes OMP's stored marker record so one command completes the logout.
export async function removeOmpCredentialRecord(ctx: OmpCommandContext | undefined): Promise<"removed" | "absent" | "unavailable"> {
  try {
    const credentials = ctx?.modelRegistry?.authStorage?.credentials;
    if (!credentials?.remove || !credentials.getOAuth) return "unavailable";
    if (!credentials.getOAuth("antigravity-acp")) return "absent";
    await credentials.remove("antigravity-acp");
    try { await ctx?.modelRegistry?.refreshProvider?.("antigravity-acp", "online"); } catch { /* advisory only */ }
    return "removed";
  } catch { return "unavailable"; }
}

export interface AuthCoordinatorDeps {
  pi: {
    on: (name: string, handler: (event: unknown, ctx: OmpCommandContext) => unknown) => void;
  };
  connections: Set<TierConnection>;
  isPoolBusy: () => boolean;
  logoutAllRuntimes: () => Promise<void>;
  closeAllRuntimes: () => Promise<void>;
  onSyncProvider: () => void;
}

const freshGoogleLoginBrand = Symbol("fresh google login attempt");

export type FreshGoogleLoginAttempt = {
  readonly [freshGoogleLoginBrand]: true;
};

interface CredentialStore {
  applicable: boolean;
  present: () => Promise<boolean | undefined>;
  remove: () => Promise<boolean | undefined>;
}

// Clear one credential store and verify it. An entry that is already gone is an
// idempotent success; a store whose availability is unknown is never deleted
// blind and never certified; a removal that claims success but leaves the item
// in place is retried and then reported as unconfirmed.
async function removeStoreDurably(store: CredentialStore): Promise<boolean | undefined> {
  let foundPresent = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const present = await store.present();
    if (present === false) return true;
    if (present === undefined) return foundPresent ? false : undefined;
    foundPresent = true;
    const removed = await store.remove();
    if (removed !== true) return false;
    await delay(logoutFollow.removalRetryMs);
  }
  return (await store.present()) === false;
}

// OMP's oauth contract has no logout hook: /logout only removes the stored
// marker credential. Watching the credential store's generation counter lets
// this adapter finish the Antigravity-side logout when OMP reports removal.
export class OmpAuthCoordinator {
  private watchingCredentials = false;
  private activeContext: OmpCommandContext | undefined;
  private markerPresent: boolean | undefined;
  private suppressFollow = false;
  private baseSuppressFollow = false;
  private readonly activeLogins = new Set<FreshGoogleLoginAttempt>();
  private disabledUntil = 0;
  private selfLogout = false;
  // Whether registerProvider keeps the non-secret config apiKey fallback.
  apiKeyFallback = true;
  private followTimer: NodeJS.Timeout | undefined;
  private followRetry: NodeJS.Timeout | undefined;

  constructor(private readonly deps: AuthCoordinatorDeps) {}

  ompMarkerStored(ctx: OmpCommandContext | undefined): boolean | undefined {
    try {
      return Boolean(ctx?.modelRegistry?.authStorage?.credentials?.getOAuth?.("antigravity-acp"));
    } catch { return undefined; }
  }

  // A dying ACP server can flush its in-memory token back to the keychain (or
  // the Secret Service) racing a plain deletion and restoring the previous
  // account. Wait for this adapter's server processes to fully exit first, then
  // verify both stores.
  async removeCredentialsDurably(): Promise<{ keychainRemoved: boolean | undefined; keyringRemoved: boolean | undefined }> {
    const pending = [...this.deps.connections].map(connection => connection.process.exited.catch(() => undefined));
    if (pending.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.allSettled(pending),
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, 10_000);
            timer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    return {
      keychainRemoved: await removeStoreDurably(keychain),
      keyringRemoved: await removeStoreDurably(secretService),
    };
  }

  // /login must mean a fresh Google sign-in: drop stored credentials (and this
  // process's old-account servers) so a new server cannot silently reuse the
  // saved login and keep the previous account.
  noteLoginSucceeded(attempt: FreshGoogleLoginAttempt): void {
    if (!this.activeLogins.delete(attempt)) return;
    if (this.activeLogins.size > 0) {
      this.baseSuppressFollow = false;
      this.disabledUntil = 0;
      return;
    }
    this.suppressFollow = false;
    this.baseSuppressFollow = false;
    this.disabledUntil = 0;
    clearTimeout(this.followTimer);
    this.followTimer = undefined;
    clearTimeout(this.followRetry);
    this.followRetry = undefined;
    if (!this.apiKeyFallback) {
      this.apiKeyFallback = true;
      this.deps.onSyncProvider();
    }
  }

  cancelFreshGoogleLogin(attempt: FreshGoogleLoginAttempt): void {
    if (!this.activeLogins.delete(attempt) || this.activeLogins.size > 0) return;
    this.suppressFollow = this.baseSuppressFollow || performance.now() < this.disabledUntil;
    this.baseSuppressFollow = false;
    clearTimeout(this.followTimer);
    this.followTimer = undefined;
    this.restoreApiKeyFallback(this.activeContext);
  }

  private restoreApiKeyFallback(ctx: OmpCommandContext | undefined): void {
    // A confirmed marker deletion is a logged-out state, including when a
    // browser login was cancelled. Never synthesize a credential fallback.
    if ((this.ompMarkerStored(ctx) ?? this.markerPresent) === false || this.apiKeyFallback) return;
    this.apiKeyFallback = true;
    this.deps.onSyncProvider();
  }

  async beginFreshGoogleLogin(): Promise<FreshGoogleLoginAttempt> {
    if (this.deps.isPoolBusy()) {
      throw new Error("Wait for active Antigravity requests to finish before logging in.");
    }
    // OMP removes the stale marker while the browser sign-in is still running.
    // That generation change must not be mistaken for a user logout and close
    // the new ACP runtime before the login can finish, so suppress it before
    // the teardown below can yield.
    const attempt: FreshGoogleLoginAttempt = { [freshGoogleLoginBrand]: true };
    if (this.activeLogins.size === 0) {
      this.baseSuppressFollow = this.suppressFollow;
    }
    this.activeLogins.add(attempt);
    this.suppressFollow = true;
    try {
      clearTimeout(this.followTimer);
      this.followTimer = undefined;
      clearTimeout(this.followRetry);
      this.followRetry = undefined;
      await this.deps.closeAllRuntimes();
      // A different Google login must not restore the previous account's ACP
      // mappings. OMP retains its transcript for a fresh backend reconstruction.
      await this.deps.logoutAllRuntimes();
      clearAntigravityCredentials();
      // The old credentials must be gone before a new sign-in can start; an
      // unconfirmed removal refuses the login instead of silently reusing it.
      const { keychainRemoved, keyringRemoved } = await this.removeCredentialsDurably();
      if (keychainRemoved === false || keyringRemoved === false
        || (keychain.applicable && keychainRemoved !== true)
        || (secretService.applicable && keyringRemoved !== true)) {
        throw new Error("Unable to confirm removal of the Antigravity credentials");
      }
      return attempt;
    } catch (error) {
      // A refused or aborted login cleans up its own identity. The caller has
      // no identity to cancel until this method fulfills.
      if (this.activeLogins.delete(attempt) && this.activeLogins.size === 0) {
        this.suppressFollow = this.baseSuppressFollow || performance.now() < this.disabledUntil;
        this.baseSuppressFollow = false;
      }
      throw error;
    }
  }

  async performCommandLogout(ctx: OmpCommandContext): Promise<{
    keychainRemoved: boolean | undefined;
    keyringRemoved: boolean | undefined;
    ompMarker: "removed" | "absent" | "unavailable";
  }> {
    if (this.deps.isPoolBusy()) {
      throw new Error("Wait for active Antigravity requests to finish before logging out.");
    }
    clearTimeout(this.followTimer);
    this.followTimer = undefined;
    clearTimeout(this.followRetry);
    this.followRetry = undefined;
    await this.deps.logoutAllRuntimes();
    await this.deps.closeAllRuntimes();
    const { keychainRemoved, keyringRemoved } = await this.removeCredentialsDurably();
    // Removing the marker ourselves must not trigger the follow-up logout.
    this.selfLogout = true;
    let ompMarker: "removed" | "absent" | "unavailable";
    try {
      ompMarker = await removeOmpCredentialRecord(ctx);
      if (ompMarker !== "unavailable") {
        // A generation event firing after the selfLogout window would compare
        // against a stale markerPresent and schedule a redundant follow-up.
        this.markerPresent = this.ompMarkerStored(ctx);
        clearTimeout(this.followTimer);
        this.followTimer = undefined;
      }
    } finally { this.selfLogout = false; }
    if (ompMarker !== "unavailable") {
      // Drop the config apiKey with the marker even without the watcher.
      this.apiKeyFallback = false;
      this.deps.onSyncProvider();
    }
    return { keychainRemoved, keyringRemoved, ompMarker };
  }

  private async finishFollowedLogout(ctx: OmpCommandContext): Promise<void> {
    const activeCtx = this.activeContext ?? ctx;
    if (this.deps.isPoolBusy()) {
      // Never interrupt an in-flight Antigravity request; retry once idle.
      clearTimeout(this.followRetry);
      this.followRetry = setTimeout(() => {
        this.followRetry = undefined;
        const currentCtx = this.activeContext ?? activeCtx;
        if (this.ompMarkerStored(currentCtx) === false) this.runFollowedLogout(currentCtx);
      }, logoutFollow.retryMs);
      this.followRetry.unref?.();
      return;
    }
    await this.deps.logoutAllRuntimes();
    await this.deps.closeAllRuntimes();
    // A quick re-login can restore the marker while the steps above await;
    // a restored or unknown marker keeps the new credentials untouched.
    if (this.ompMarkerStored(this.activeContext ?? activeCtx) !== false) return;
    const { keychainRemoved, keyringRemoved } = await this.removeCredentialsDurably();
    // Keep the confirmation terse; /antigravity-acp account shows the details.
    try {
      (this.activeContext ?? activeCtx)?.ui?.notify?.(
        formatLogoutSummary({ keychainRemoved, keyringRemoved, followed: true }), "info");
    } catch { /* the host UI may already be gone */ }
  }

  // The follow-up runs detached from timer callbacks; a failure must not
  // become an unhandled rejection, and the notice stays credential-free.
  private runFollowedLogout(ctx: OmpCommandContext): void {
    const activeCtx = this.activeContext ?? ctx;
    void this.finishFollowedLogout(activeCtx).catch(() => {
      try {
        (this.activeContext ?? activeCtx)?.ui?.notify?.("Antigravity ACP: the logout OMP started could not be finished. Run /antigravity-acp logout to retry.", "error");
      } catch { /* the host UI may already be gone */ }
    });
  }

  watchOmpCredentials(ctx: OmpCommandContext | undefined): void {
    if (!ctx) return;
    const credentials = ctx.modelRegistry?.authStorage?.credentials;
    if (credentials?.getOAuth && credentials.onGeneration) this.activeContext = ctx;
    if (this.watchingCredentials) return;
    if (!credentials?.getOAuth || !credentials.onGeneration) return;
    const initial = this.ompMarkerStored(ctx);
    if (initial === undefined) return;
    this.watchingCredentials = true;
    this.markerPresent = initial;
    // Automatic soft-disables (for example an invalid_grant refresh) must not
    // destroy the Antigravity-side login. OMP emits credential_disabled for
    // those, but not for user-initiated removals such as /logout.
    this.deps.pi.on("credential_disabled", (event: unknown) => {
      if (event && typeof event === "object" && "provider" in event && event.provider === "antigravity-acp") {
        this.disabledUntil = performance.now() + logoutFollow.disabledSuppressionMs;
        this.suppressFollow = true;
      }
    });
    credentials.onGeneration(() => {
      const activeCtx = this.activeContext ?? ctx;
      const current = this.ompMarkerStored(activeCtx);
      if (current === undefined) return;
      const wasPresent = this.markerPresent === true;
      this.markerPresent = current;
      if (current) {
        this.suppressFollow = false;
        this.baseSuppressFollow = false;
        this.disabledUntil = 0;
      } else if (this.activeLogins.size > 0) {
        this.suppressFollow = true;
      } else if (performance.now() >= this.disabledUntil) {
        this.suppressFollow = false;
      }
      if (wasPresent !== current) {
        // Flip the config apiKey in the same synchronous tick as the marker
        // change: OMP's own logout report then finds no remaining
        // "provider config (fallback)" source, while a fresh profile that
        // never stored a marker keeps the catalog visible.
        this.apiKeyFallback = current;
        this.deps.onSyncProvider();
      }
      if (!wasPresent || current || this.selfLogout) return;
      clearTimeout(this.followTimer);
      this.followTimer = setTimeout(() => {
        this.followTimer = undefined;
        if (process.env.OMP_ACP_FOLLOW_LOGOUT === "0") return;
        if (this.suppressFollow && (this.activeLogins.size > 0 || performance.now() < this.disabledUntil)) {
          this.suppressFollow = false;
          this.disabledUntil = 0;
          this.restoreApiKeyFallback(activeCtx);
          return;
        }
        // A quick re-login after the removal cancels the cleanup.
        const currentCtx = this.activeContext ?? activeCtx;
        if (this.ompMarkerStored(currentCtx) !== false) {
          this.restoreApiKeyFallback(currentCtx);
          return;
        }
        this.runFollowedLogout(currentCtx);
      }, logoutFollow.delayMs);
      this.followTimer.unref?.();
    });
  }
}
