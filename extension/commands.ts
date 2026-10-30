import { describeCredentialStorage, inspectAntigravityAuth, savePermissionMode } from "./runtime.mjs";
import { antigravityAccountEmail, authReady, formatLogoutSummary, keychain, ompCredentialSummary, type OmpAuthCoordinator, type OmpCommandContext } from "./auth-sync.ts";
import { parseNativeToolMode, type NativeToolMode } from "./tool-routing.ts";
import { saveToolPolicy, type ToolPolicy } from "./tool-policy.ts";
import { updateContextSettings, resolveContextOptions, saveContextSettings, type ContextSettings } from "./context-settings.ts";
import type { CatalogStore, ConfiguredCatalogModel } from "./catalog-store.ts";
import type { SessionCleanup, CleanupMode } from "./session-cleanup.ts";
import type { Diagnostics } from "./diagnostics.ts";
import type { TierConnection } from "./tier-connection.ts";

export interface RuntimeSnapshotProcess {
  mcpHttp: boolean;
  omittedTools: unknown[];
  [key: string]: unknown;
}

export interface RuntimeSnapshotView {
  bindings: number;
  permissionMode: string;
  metrics: unknown;
  processes: RuntimeSnapshotProcess[];
}

export interface StreamUsageLike { input?: unknown; output?: unknown; cacheRead?: unknown; cost?: unknown }
export interface StreamEventLike {
  message?: { usage?: StreamUsageLike; timestamp?: number };
  partial?: { usage?: StreamUsageLike; timestamp?: number };
}

export interface RuntimeBundleView {
  runtime: {
    snapshot: () => Promise<RuntimeSnapshotView>;
    setPermissionMode: (mode: string) => Promise<void>;
    logout: () => Promise<void>;
    close: () => Promise<void>;
    getPermission: (requestId: string) => { id: string; title: string; options: Array<{ id?: string; label: string }> } | undefined;
    sessionStore?: { read: () => unknown[]; clear: () => void };
  };
  provider: {
    auth: {
      oauth: {
        login: (callbacks: {
          signal?: AbortSignal;
          notify: (event: { message?: string; links?: Array<{ url: string }> }) => void;
          prompt: (request: { message: string; placeholder?: string }) => Promise<string>;
        }) => Promise<unknown>;
        refresh: (credentials: unknown) => Promise<unknown>;
      };
    };
    streamSimple: (model: { id: string }, context: unknown, options?: unknown) => AsyncIterable<StreamEventLike>;
  };
  isBusy: () => boolean;
}

export interface ToolAuditSummary {
  offered: string[];
  available: string[];
  omitted: Array<{ name: string; reason: string }>;
}

export interface CommandControllerDeps {
  configPath: string;
  contextPath: string;
  toolPolicyPath: string;
  cleanup: SessionCleanup;
  diagnostics?: Diagnostics;
  connections: Set<TierConnection>;
  auth: OmpAuthCoordinator;
  catalog: CatalogStore;
  prepareRuntime: () => Promise<void>;
  getContextSettings: () => ContextSettings;
  setContextSettings: (next: ContextSettings) => void;
  getToolPolicy: () => ToolPolicy;
  setToolPolicy: (next: ToolPolicy) => void;
  setPermissionModeState: (mode: string) => void;
  getLastToolAudit: () => ToolAuditSummary | undefined;
  getRuntimeForSession: (sessionId?: string) => RuntimeBundleView;
  acquireRuntimeForSession?: (sessionId?: string) => { value: RuntimeBundleView; release: () => void };
  peekRuntimeForSession: (sessionId?: string) => RuntimeBundleView | undefined;
  getSavedSessionCount: () => number;
  getPermissionMode: () => string;
  getAllRuntimes: () => RuntimeBundleView[];
  closeAllRuntimes: () => Promise<void>;
  onModelsUpdated: (models: ConfiguredCatalogModel[]) => void;
}

export function createAntigravityCommandHandler(deps: CommandControllerDeps) {
  const sessionIdOf = (ctx: OmpCommandContext | undefined): string | undefined => ctx?.sessionManager?.getSessionId?.();

  return async function handleCommand(args: string, ctx: OmpCommandContext): Promise<void> {
    deps.auth.watchOmpCredentials(ctx);
    const parts = args.trim().split(/\s+/);
    const [command, value] = parts;
    if (command === "diagnostics") {
      if (parts.length > 2 || (value !== undefined && !["on", "off", "reset"].includes(value))) throw new Error("Usage: /antigravity-acp diagnostics [on|off|reset]");
      if (value === "reset") deps.diagnostics?.reset();
      else if (value) deps.diagnostics?.configure(value === "on");
      ctx.ui.notify(JSON.stringify(deps.diagnostics?.status() ?? { enabled: false }, null, 2), "info");
      return;
    }

    if (command === "cleanup") {
      if (value === "budget") {
        if (parts.length !== 4) throw new Error("Usage: /antigravity-acp cleanup budget MAX_SESSIONS MAX_MIB (0 disables a limit)");
        deps.cleanup.budget(Number(parts[2]), Number(parts[3]) * 1024 * 1024);
      } else
      if (value) {
        if (!["off", "conservative", "timeout", "balanced"].includes(value) || parts.length > 3 || (parts[2] !== undefined && !["timeout", "balanced"].includes(value))) {
          throw new Error("Usage: /antigravity-acp cleanup [off|conservative|timeout|balanced [DAYS]]");
        }
        deps.cleanup.configure(value as CleanupMode, parts[2] === undefined ? undefined : Number(parts[2]));
        deps.cleanup.start();
      }
      deps.cleanup.start();
      const removed = await deps.cleanup.collect();
      ctx.ui.notify(JSON.stringify({
        ...deps.cleanup.status(),
        removed,
        note: "Active sessions are protected. Timeout cleanup loses ACP-only state; OMP history is retained.",
      }, null, 2), "info");
      return;
    }

    if (command === "context") {
      const currentSettings = deps.getContextSettings();
      if (value === "set") {
        const [, , target, key, raw] = parts;
        if (parts.length !== 5 || !target || !key || raw === undefined) {
          throw new Error("Usage: /antigravity-acp context set default|MODEL KEY NUMBER");
        }
        const next = updateContextSettings(currentSettings, target, key, key === "usageMode" ? raw : Number(raw));
        for (const model of deps.catalog.currentModels) resolveContextOptions(model, next);
        saveContextSettings(deps.contextPath, next);
        deps.setContextSettings(next);
        if (key === "usageMode") {
          for (const connection of deps.connections) connection.configureUsage(raw as "auto" | "off");
        }
        deps.onModelsUpdated(deps.catalog.reconfigure(next));
        ctx.ui.notify("ACP context settings saved. Restart OMP or reselect the model to refresh its displayed limits.", "info");
      } else if (value) {
        throw new Error("Usage: /antigravity-acp context [set default|MODEL KEY NUMBER]");
      } else {
        ctx.ui.notify(JSON.stringify({
          file: deps.contextPath,
          settings: currentSettings,
          effective: deps.catalog.currentModels.map(model => ({ id: model.id, ...resolveContextOptions(model, currentSettings) })),
        }, null, 2), "info");
      }
      return;
    }

    if (command === "usage" && value) {
      if (parts.length !== 2 || (value !== "auto" && value !== "off")) throw new Error("Usage: /antigravity-acp usage [auto|off]");
      const next = updateContextSettings(deps.getContextSettings(), "default", "usageMode", value);
      saveContextSettings(deps.contextPath, next);
      deps.setContextSettings(next);
      for (const connection of deps.connections) connection.configureUsage(value);
      ctx.ui.notify(`Supplemental ACP usage queries: ${value}${process.env.OMP_ACP_USAGE === "off" ? " (environment override keeps queries off)" : ""}. Context occupancy updates remain enabled.`, "info");
      return;
    }

    if (command === "debug") {
      if (parts.length !== 2 || (value !== "on" && value !== "off")) throw new Error("Usage: /antigravity-acp debug on|off");
      const enabled = value === "on";
      const next = { ...deps.getToolPolicy(), debugToolUpdates: enabled };
      saveToolPolicy(deps.toolPolicyPath, next);
      deps.setToolPolicy(next);
      for (const connection of deps.connections) connection.debugToolUpdates = enabled;
      ctx.ui.notify(`ACP tool-status debug display: ${value}. Normal OMP tool results and thought summaries are preserved.`, "info");
      return;
    }

    if (command === "native-tools") {
      if (parts.length !== 2) throw new Error("Usage: /antigravity-acp native-tools prefer|disabled");
      const mode: NativeToolMode = parseNativeToolMode(value);
      const next = { ...deps.getToolPolicy(), nativeTools: mode };
      saveToolPolicy(deps.toolPolicyPath, next);
      await deps.closeAllRuntimes();
      deps.setToolPolicy(next);
      ctx.ui.notify(`Native tools: ${mode}. ACP connections will be recreated on the next request with the new policy.`, "info");
      return;
    }

    if (command === "login") {
      if (value) throw new Error("Usage: /antigravity-acp login");
      await deps.prepareRuntime();
      await deps.auth.beginFreshGoogleLogin();
      // Direct Antigravity Google login through the command UI. OMP's /login
      // runs the same flow and additionally stores the provider marker.
      const lease = deps.acquireRuntimeForSession ? deps.acquireRuntimeForSession() : { value: deps.getRuntimeForSession(), release: () => {} };
      try {
        await lease.value.provider.auth.oauth.login({
          signal: undefined,
          notify(event) {
            const link = event.links?.[0];
            if (link) ctx.ui.notify(`${event.message ?? "Open this URL to authorize:"}\n${link.url}`, "info");
            else if (event.message) ctx.ui.notify(event.message, "info");
          },
          prompt: async (request) => {
            const answer = await ctx.ui.input?.(request.message, request.placeholder);
            if (!answer?.trim()) throw new Error("Antigravity OAuth login cancelled");
            return answer;
          },
        });
      } finally {
        lease.release();
      }
      deps.auth.noteLoginSucceeded?.();
      const auth = inspectAntigravityAuth();
      const email = antigravityAccountEmail();
      ctx.ui.notify(`Antigravity Google login finished${email ? ` as ${email}` : ""} — fresh sign-in; ACP auth: ${auth.status}${auth.authType ? ` (${auth.authType})` : ""}.`, "info");
      return;
    }

    if (command === "logout") {
      if (value) throw new Error("Usage: /antigravity-acp logout");
      const { keychainRemoved, ompMarker } = await deps.auth.performCommandLogout(ctx);
      // Keep the confirmation terse; /antigravity-acp account shows the details.
      ctx.ui.notify(formatLogoutSummary({ keychainRemoved, ompMarker }), "info");
      return;
    }

    if (command === "account") {
      if (value) throw new Error("Usage: /antigravity-acp account");
      const auth = inspectAntigravityAuth();
      let ompSource: string | undefined;
      try { ompSource = ctx?.modelRegistry?.authStorage?.keys?.describe?.("antigravity-acp", sessionIdOf(ctx)); } catch { /* host version dependent */ }
      // Reading saved state needs no live runtime; show live numbers only
      // when a runtime for this session already exists.
      const bundle = deps.peekRuntimeForSession(sessionIdOf(ctx));
      const snapshot = await bundle?.runtime.snapshot();
      const permissionMode = snapshot?.permissionMode ?? deps.getPermissionMode();
      const omp = ompCredentialSummary(ctx);
      const marker = omp.present === undefined ? "unknown (host did not expose the credential store)"
        : omp.present ? `present, authorized ${omp.authorizedAt ?? "unknown time"}${omp.email ? ` as ${omp.email}` : ""} (${omp.record})`
        : "not stored; run /login or /antigravity-acp login";
      // Mirrors the upstream provider's status/doctor wording for the shared
      // fields, with OMP-specific lines in the same style.
      ctx.ui.notify([
        "Antigravity ACP account",
        `Google account: ${antigravityAccountEmail() ?? (keychain.present() === true ? "signed in (token in macOS keychain; email not read)" : "not signed in")}`,
        `Authentication: ${auth.status}${auth.authType ? ` (${auth.authType})` : ""}`,
        `Credential storage (preflight): ${describeCredentialStorage()}`,
        `OMP marker record: ${marker}`,
        ompSource ? `OMP auth source: ${ompSource}` : undefined,
        `Saved ACP sessions: ${deps.getSavedSessionCount()}`,
        `Requested permission mode: ${permissionMode === "auto_edit" ? "auto-edit" : permissionMode}`,
        `Active bindings: ${snapshot?.bindings ?? 0}`,
        "Google OAuth tokens stay in Antigravity-owned storage; OMP stores only a non-secret marker. /antigravity-acp logout clears both sides; OMP /logout also finishes the Antigravity-side cleanup.",
      ].filter(Boolean).join("\n"), "info");
      return;
    }

    if (command === "usage") {
      const currentSettings = deps.getContextSettings();
      ctx.ui.notify(JSON.stringify({
        configured: currentSettings.defaults.usageMode ?? "auto",
        effective: process.env.OMP_ACP_USAGE === "off" ? "off" : currentSettings.defaults.usageMode ?? "auto",
        connections: [...deps.connections].map(connection => ({
          context: [...connection.contextUsage.values()],
          accounting: [...connection.usageStatus.values()],
          activePrompts: connection.activePrompts,
        })),
      }, null, 2), "info");
      return;
    }

    if (command === "refresh") {
      if (value !== undefined) throw new Error("Usage: /antigravity-acp refresh");
      const refreshed = await deps.catalog.refresh(deps.getContextSettings());
      deps.onModelsUpdated(refreshed);
      ctx.ui.notify(`Refreshed ACP model cache: ${refreshed.map(model => model.id).join(", ")}`, "info");
      return;
    }

    if (command === "permissions") {
      if (!value || !["default", "auto-edit", "yolo"].includes(value) || parts.length > 2) {
        throw new Error("Usage: /antigravity-acp permissions default|auto-edit|yolo");
      }
      const mode = value.replace("-", "_");
      savePermissionMode(mode, deps.configPath);
      deps.setPermissionModeState(mode);
      await Promise.all(deps.getAllRuntimes().map(bundle => bundle.runtime.setPermissionMode(mode)));
    }
    const usageError = "Usage: /antigravity-acp [status|account|login|logout|tools|usage|context|cleanup|diagnostics|debug|native-tools|permissions|refresh]";
    if (command && command !== "status" && command !== "tools" && command !== "permissions") {
      throw new Error(usageError);
    }
    if (command === "status" && value !== undefined) throw new Error(usageError);
    if (command === "tools" && value !== undefined) throw new Error("Usage: /antigravity-acp tools");

    // Only the tools inspection and the status display below need a live
    // runtime; every earlier command runs without one.
    const { runtime } = deps.getRuntimeForSession(sessionIdOf(ctx));
    const snapshot = await runtime.snapshot();
    if (command === "tools") {
      const lastToolAudit = deps.getLastToolAudit();
      ctx.ui.notify(lastToolAudit
        ? `OMP ACP tool bridge\nAvailable: ${lastToolAudit.available.join(", ")}\nOmitted: ${JSON.stringify(lastToolAudit.omitted)}\nLive ACP checks: ${JSON.stringify(snapshot.processes.map(item => ({ mcpHttp: item.mcpHttp, omittedTools: item.omittedTools })))}`
        : "No model request yet. Send a message with this ACP model to inspect its offered OMP tools.", "info");
      return;
    }

    const policy = deps.getToolPolicy();
    ctx.ui.notify(`Antigravity ACP (OMP adapter)\nAuth storage: ${authReady() ? "configured (ACP-owned token file or macOS keychain)" : inspectAntigravityAuth().status}\nPermissions: ${snapshot.permissionMode}\nNative tools: ${policy.nativeTools}\nDebug tool updates: ${policy.debugToolUpdates ? "on" : "off"}\nTool routing: ${JSON.stringify([...deps.connections].map(connection => connection.toolRouting).filter(Boolean))}\nActive sessions: ${snapshot.bindings}\nConfirmed thinking: ${JSON.stringify([...deps.connections].map(connection => connection.confirmedThinking).filter(Boolean))}\nUsage: ${JSON.stringify(snapshot.metrics)}\n${JSON.stringify(snapshot.processes)}`, "info");
  };
}
