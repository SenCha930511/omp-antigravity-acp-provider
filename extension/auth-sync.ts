import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { clearAntigravityCredentials, hasAntigravityAuth, resolveAntigravityAcpDirectory } from "./runtime.mjs";
import type { TierConnection } from "./tier-connection.ts";

export const MARKER = "pi-antigravity-acp:managed-by-antigravity";

const execFileAsync = promisify(execFile);

// The real /usr/bin/security subprocess boundary, with its own binary
// parameter so tests can drive a stub executable through the same code path.
// Captured stderr is matched in memory only; it is never logged or persisted.
export function runSecurity(args: string[], bin = "/usr/bin/security"): Promise<void> {
  return execFileAsync(bin, args, { stdio: ["ignore", "ignore", "pipe"], timeout: 3000 }).then(() => undefined);
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

// macOS keychain operations behind one mutable object so offline command
// tests can substitute them without touching the user's real keychain.
// present/remove resolve to true (present / removed), false (confirmed
// absent), or undefined (not macOS); any other subprocess failure rejects
// with a fixed credential-free message.
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
  return {
    // Check existence only: the item's ACL does not authorize the security
    // CLI, so a `find-generic-password -w` would pop the macOS keychain
    // password dialog. Attribute-only lookups stay prompt-free.
    present: (): Promise<boolean | undefined> => check(["find-generic-password", "-s", "gemini", "-a", "antigravity-acp"], "Unable to inspect the Antigravity keychain entry"),
    // Local logout for macOS keychain storage. The Antigravity server owns
    // this item; removing it is required for a complete logout when no token
    // file exists.
    remove: (): Promise<boolean | undefined> => check(["delete-generic-password", "-s", "gemini", "-a", "antigravity-acp"], "Unable to remove the Antigravity keychain entry"),
  };
}

export const keychain = createKeychain(runSecurity);

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
// run the delayed detection without real waits.
export const logoutFollow = { delayMs: 500, retryMs: 15_000 };

// Shared wording for both logout confirmations (direct command and the
// follow-up that finishes a logout OMP started).
export function formatLogoutSummary(options: { keychainRemoved: boolean | undefined; ompMarker?: "removed" | "absent" | "unavailable"; followed?: boolean }): string {
  const cleared = ["Google credentials", "saved ACP sessions"];
  if (options.keychainRemoved === true) cleared.push("the macOS keychain entry");
  if (options.ompMarker === "removed") cleared.push("the OMP marker record");
  const list = cleared.slice(0, -1).join(", ") + " and " + cleared[cleared.length - 1];
  return `${options.followed ? "Antigravity ACP: finished the logout OMP started — " : "Antigravity ACP: logged out — "}${list} cleared.` +
    (options.ompMarker === "unavailable" ? " The OMP marker record could not be removed; run /logout to drop it." : "") +
    (options.keychainRemoved === false ? " The macOS keychain entry was not present or not removable." : "");
}

export async function authReady(): Promise<boolean> {
  return hasAntigravityAuth() || (await keychain.present()) === true;
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

// OMP's oauth contract has no logout hook: /logout only removes the stored
// marker credential. Watching the credential store's generation counter lets
// this adapter finish the Antigravity-side logout when OMP reports removal.
export class OmpAuthCoordinator {
  private watchingCredentials = false;
  private markerPresent: boolean | undefined;
  private suppressFollow = false;
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

  // A dying ACP server can flush its in-memory token back to the keychain,
  // racing a plain deletion and restoring the previous account. Wait for this
  // adapter's server processes to fully exit first, then verify the removal.
  async removeKeychainCredentialDurably(): Promise<boolean | undefined> {
    const pending = [...this.deps.connections].map(connection => connection.process.exited.catch(() => undefined));
    if (pending.length > 0) {
      await Promise.race([Promise.allSettled(pending), delay(10_000)]);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if ((await keychain.present()) === false) return true;
      const removed = await keychain.remove();
      if (removed !== true) return removed;
      await delay(400);
    }
    return (await keychain.present()) === false;
  }

  // /login must mean a fresh Google sign-in: drop stored credentials (and this
  // process's old-account servers) so a new server cannot silently reuse the
  // saved login and keep the previous account.
  noteLoginSucceeded(): void {
    clearTimeout(this.followTimer);
    this.followTimer = undefined;
    clearTimeout(this.followRetry);
    this.followRetry = undefined;
    this.suppressFollow = false;
    if (!this.apiKeyFallback) {
      this.apiKeyFallback = true;
      this.deps.onSyncProvider();
    }
  }

  async beginFreshGoogleLogin(): Promise<void> {
    if (this.deps.isPoolBusy()) {
      throw new Error("Wait for active Antigravity requests to finish before logging in.");
    }
    clearTimeout(this.followTimer);
    this.followTimer = undefined;
    clearTimeout(this.followRetry);
    this.followRetry = undefined;
    await this.deps.closeAllRuntimes();
    // A different Google login must not restore the previous account's ACP
    // mappings. OMP retains its transcript for a fresh backend reconstruction.
    await this.deps.logoutAllRuntimes();
    clearAntigravityCredentials();
    // The old keychain entry must be gone before a new sign-in can start; an
    // unconfirmed removal refuses the login instead of silently reusing it.
    if (await this.removeKeychainCredentialDurably() === false) {
      throw new Error("Unable to confirm removal of the Antigravity keychain entry");
    }
  }

  async performCommandLogout(ctx: OmpCommandContext): Promise<{ keychainRemoved: boolean | undefined; ompMarker: "removed" | "absent" | "unavailable" }> {
    if (this.deps.isPoolBusy()) {
      throw new Error("Wait for active Antigravity requests to finish before logging out.");
    }
    clearTimeout(this.followTimer);
    this.followTimer = undefined;
    clearTimeout(this.followRetry);
    this.followRetry = undefined;
    await this.deps.logoutAllRuntimes();
    await this.deps.closeAllRuntimes();
    const keychainRemoved = await this.removeKeychainCredentialDurably();
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
    return { keychainRemoved, ompMarker };
  }

  private async finishFollowedLogout(ctx: OmpCommandContext): Promise<void> {
    if (this.deps.isPoolBusy()) {
      // Never interrupt an in-flight Antigravity request; retry once idle.
      clearTimeout(this.followRetry);
      this.followRetry = setTimeout(() => {
        this.followRetry = undefined;
        if (this.ompMarkerStored(ctx) === false) this.runFollowedLogout(ctx);
      }, logoutFollow.retryMs);
      this.followRetry.unref?.();
      return;
    }
    await this.deps.logoutAllRuntimes();
    await this.deps.closeAllRuntimes();
    // A quick re-login can restore the marker while the steps above await;
    // a restored or unknown marker keeps the new keychain entry untouched.
    if (this.ompMarkerStored(ctx) !== false) return;
    const keychainRemoved = await this.removeKeychainCredentialDurably();
    // Keep the confirmation terse; /antigravity-acp account shows the details.
    try {
      ctx?.ui?.notify?.(formatLogoutSummary({ keychainRemoved, followed: true }), "info");
    } catch { /* the host UI may already be gone */ }
  }

  // The follow-up runs detached from timer callbacks; a failure must not
  // become an unhandled rejection, and the notice stays credential-free.
  private runFollowedLogout(ctx: OmpCommandContext): void {
    void this.finishFollowedLogout(ctx).catch(() => {
      try {
        ctx?.ui?.notify?.("Antigravity ACP: the logout OMP started could not be finished. Run /antigravity-acp logout to retry.", "error");
      } catch { /* the host UI may already be gone */ }
    });
  }

  watchOmpCredentials(ctx: OmpCommandContext | undefined): void {
    if (this.watchingCredentials || !ctx) return;
    const credentials = ctx.modelRegistry?.authStorage?.credentials;
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
        this.suppressFollow = true;
      }
    });
    credentials.onGeneration(() => {
      const current = this.ompMarkerStored(ctx);
      if (current === undefined) return;
      const wasPresent = this.markerPresent === true;
      this.markerPresent = current;
      if (current) this.suppressFollow = false;
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
        if (this.suppressFollow) {
          this.suppressFollow = false;
          this.apiKeyFallback = true;
          this.deps.onSyncProvider();
          return;
        }
        // A quick re-login after the removal cancels the cleanup.
        if (this.ompMarkerStored(ctx) !== false) {
          this.apiKeyFallback = true;
          this.deps.onSyncProvider();
          return;
        }
        this.runFollowedLogout(ctx);
      }, logoutFollow.delayMs);
      this.followTimer.unref?.();
    });
  }
}
