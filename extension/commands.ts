import { describeCredentialStorage, savePermissionMode } from "./runtime.mjs";
import { antigravityAccountEmail, formatLogoutSummary, inspectAcpAuth, keychain, ompCredentialSummary, type OmpAuthCoordinator, type OmpCommandContext } from "./auth-sync.ts";
import { parseNativeToolMode, type NativeToolMode } from "./tool-routing.ts";
import { saveToolPolicy, type ToolPolicy } from "./tool-policy.ts";
import { DEFAULT_USAGE_MODE, updateContextSettings, resolveContextOptions, saveContextSettings, type ContextSettings } from "./context-settings.ts";
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

// OMP's TUI forwards an extension command's getArgumentCompletions into its
// slash-command autocomplete (same wiring the built-in autoresearch command
// uses). Items replace the argument text after "/antigravity-acp ", so values
// carry a trailing space to keep chained completion flowing.
export interface AntigravityCompletionItem {
  value: string;
  label: string;
  description: string;
  hint?: string;
}

export interface AntigravityCompletionDeps {
  catalog: { currentModels: ReadonlyArray<{ id: string }> };
}

interface SubcommandSpec {
  name: string;
  description: string;
  usage?: string;
  values?: Array<[label: string, description: string]>;
}

const CONTEXT_SETTING_KEYS: Array<[label: string, description: string]> = [
  ["contextWindow", "Total context window in tokens"],
  ["maxTokens", "Maximum output tokens"],
  ["inputTokenBudget", "Maximum input tokens per request"],
  ["reserveTokens", "Tokens reserved for replies"],
  ["maxTransferBytes", "Context transfer byte budget"],
  ["maxImageBytes", "Per-image byte budget"],
];

const SUBCOMMANDS: SubcommandSpec[] = [
  { name: "status", description: "Runtime, permissions and usage report (default)" },
  { name: "account", description: "Signed-in Google account and credential state" },
  { name: "login", description: "Start a fresh Antigravity Google authorization" },
  { name: "logout", description: "Clear Antigravity credentials, saved sessions and the OMP marker" },
  { name: "tools", description: "Inspect the OMP↔ACP tool bridge" },
  {
    name: "usage",
    description: "Usage accounting and connection state",
    usage: "[auto|off]",
    values: [["auto", "Query usage after each reply"], ["off", "Skip supplemental usage queries"]],
  },
  {
    name: "context",
    description: "Context window and transfer settings",
    usage: "[set default|MODEL KEY NUMBER]",
    values: [["set", "Override one setting for default or a model"]],
  },
  {
    name: "cleanup",
    description: "Collect saved ACP sessions now",
    usage: "[off|conservative|timeout|balanced [DAYS]] | budget MAX_SESSIONS MAX_MIB",
    values: [
      ["off", "Keep every saved session"],
      ["conservative", "Remove idle sessions (default)"],
      ["timeout", "Remove sessions idle for DAYS"],
      ["balanced", "Timeout cleanup plus budget enforcement"],
      ["budget", "Cap MAX_SESSIONS and MAX_MIB"],
    ],
  },
  {
    name: "diagnostics",
    description: "Diagnostics collection status",
    usage: "[on|off|reset]",
    values: [
      ["on", "Enable diagnostics collection"],
      ["off", "Disable diagnostics collection"],
      ["reset", "Clear collected diagnostics"],
    ],
  },
  {
    name: "debug",
    description: "Raw ACP tool-status display",
    usage: "on|off",
    values: [["on", "Show raw tool-status updates"], ["off", "Hide raw tool-status updates"]],
  },
  {
    name: "native-tools",
    description: "Native ACP tool exposure",
    usage: "prefer|disabled",
    values: [["prefer", "Let OMP tools shadow ACP natives (default)"], ["disabled", "Expose ACP-native tools only"]],
  },
  {
    name: "permissions",
    description: "Requested ACP permission mode",
    usage: "default|auto-edit|yolo",
    values: [
      ["default", "Confirm edits and commands"],
      ["auto-edit", "Auto-accept edits"],
      ["yolo", "Auto-accept everything"],
    ],
  },
  { name: "refresh", description: "Discover and cache advertised models" },
];

function completeValues(typed: string, values: Array<[label: string, description: string]>,
  valueOf: (label: string) => string): AntigravityCompletionItem[] | null {
  const prefix = typed.toLowerCase();
  const matched = values.filter(([label]) => label.toLowerCase().startsWith(prefix));
  return matched.length ? matched.map(([label, description]) => ({ value: valueOf(label), label, description })) : null;
}

export function createAntigravityArgumentCompletions(deps: AntigravityCompletionDeps) {
  return function getArgumentCompletions(args: string): AntigravityCompletionItem[] | null {
    const firstSpace = args.indexOf(" ");
    if (firstSpace === -1) {
      const typed = args.toLowerCase();
      const matched = SUBCOMMANDS.filter(spec => spec.name.startsWith(typed));
      return matched.length ? matched.map(spec => ({
        value: `${spec.name} `,
        label: spec.name,
        description: spec.description,
        hint: spec.usage ? `${spec.name.slice(typed.length)} ${spec.usage}` : undefined,
      })) : null;
    }
    const name = args.slice(0, firstSpace).toLowerCase();
    const spec = SUBCOMMANDS.find(entry => entry.name === name);
    const rest = args.slice(firstSpace + 1);
    if (!spec?.values) return null;
    if (spec.name === "context") {
      const restSpace = rest.indexOf(" ");
      if (restSpace === -1) return completeValues(rest, spec.values, label => `context ${label} `);
      if (rest.slice(0, restSpace).toLowerCase() !== "set") return null;
      const target = rest.slice(restSpace + 1);
      const targetSpace = target.indexOf(" ");
      if (targetSpace === -1) {
        const targets: Array<[label: string, description: string]> = [
          ["default", "Applied to every model"],
          ...deps.catalog.currentModels.map(model => [model.id, "Per-model override"] as [string, string]),
        ];
        return completeValues(target, targets, label => `context set ${label} `);
      }
      const targetName = target.slice(0, targetSpace);
      const settingKey = target.slice(targetSpace + 1);
      if (settingKey.includes(" ")) return null;
      const keys = [...CONTEXT_SETTING_KEYS];
      if (targetName === "default") keys.push(["usageMode", "auto or off"]);
      return completeValues(settingKey, keys, label => `context set ${targetName} ${label} `);
    }
    return completeValues(rest, spec.values, label => `${spec.name} ${label} `);
  };
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
      const auth = await inspectAcpAuth();
      const email = antigravityAccountEmail();
      ctx.ui.notify(`Antigravity Google login finished${email ? ` as ${email}` : ""} — fresh sign-in; ACP auth: ${auth.status}${auth.authType ? ` (${auth.authType})` : ""}.`, "info");
      return;
    }

    if (command === "logout") {
      if (value) throw new Error("Usage: /antigravity-acp logout");
      const { keychainRemoved, keyringRemoved, ompMarker } = await deps.auth.performCommandLogout(ctx);
      // Keep the confirmation terse; /antigravity-acp account shows the details.
      ctx.ui.notify(formatLogoutSummary({ keychainRemoved, keyringRemoved, ompMarker }), "info");
      return;
    }

    if (command === "account") {
      if (value) throw new Error("Usage: /antigravity-acp account");
      const auth = await inspectAcpAuth();
      let ompSource: string | undefined;
      try { ompSource = ctx?.modelRegistry?.authStorage?.keys?.describe?.("antigravity-acp", sessionIdOf(ctx)); } catch { /* host version dependent */ }
      // Reading saved state needs no live runtime; show live numbers only
      // when a runtime for this session already exists.
      const bundle = deps.peekRuntimeForSession(sessionIdOf(ctx));
      const snapshot = await bundle?.runtime.snapshot();
      const permissionMode = deps.getPermissionMode();
      const omp = ompCredentialSummary(ctx);
      const marker = omp.present === undefined ? "unknown (host did not expose the credential store)"
        : omp.present ? `present, authorized ${omp.authorizedAt ?? "unknown time"}${omp.email ? ` as ${omp.email}` : ""} (${omp.record})`
        : "not stored; run /login or /antigravity-acp login";
      // Mirrors the upstream provider's status/doctor wording for the shared
      // fields, with OMP-specific lines in the same style.
      ctx.ui.notify([
        "Antigravity ACP account",
        `Google account: ${antigravityAccountEmail() ?? ((await keychain.present()) === true ? "signed in (token in macOS keychain; email not read)" : auth.keyring ? "signed in (token in system keyring; email not read)" : "not signed in")}`,
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
        configured: currentSettings.defaults.usageMode ?? DEFAULT_USAGE_MODE,
        effective: process.env.OMP_ACP_USAGE === "off" ? "off" : currentSettings.defaults.usageMode ?? DEFAULT_USAGE_MODE,
        connections: [...deps.connections].map(connection => ({
          context: [...connection.contextUsage].map(([sessionId, usage]) => ({
            sessionId,
            ...usage,
            ompContextWindow: connection.getOmpContextWindow?.(sessionId),
          })),
          compactions: [...connection.compactions].flatMap(([sessionId, records]) =>
            [...records.values()].map(record => ({ sessionId, ...record }))),
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
      if (mode !== deps.getPermissionMode()) {
        savePermissionMode(mode, deps.configPath);
        deps.setPermissionModeState(mode);
        await deps.closeAllRuntimes();
      }
    }
    const usageError = "Usage: /antigravity-acp [status|account|login|logout|tools|usage|context|cleanup|diagnostics|debug|native-tools|permissions|refresh]";
    if (command && command !== "status" && command !== "tools" && command !== "permissions") {
      throw new Error(usageError);
    }
    if (command === "status" && value !== undefined) throw new Error(usageError);
    if (command === "tools" && value !== undefined) throw new Error("Usage: /antigravity-acp tools");

    // Only the tools inspection and the status display below need a live
    // runtime; every earlier command runs without one.
    const lease = deps.acquireRuntimeForSession
      ? deps.acquireRuntimeForSession(sessionIdOf(ctx))
      : { value: deps.getRuntimeForSession(sessionIdOf(ctx)), release: () => {} };
    try {
      const snapshot = await lease.value.runtime.snapshot();
      if (command === "tools") {
        const lastToolAudit = deps.getLastToolAudit();
        ctx.ui.notify(lastToolAudit
          ? `OMP ACP tool bridge\nAvailable: ${lastToolAudit.available.join(", ")}\nOmitted: ${JSON.stringify(lastToolAudit.omitted)}\nLive ACP checks: ${JSON.stringify(snapshot.processes.map(item => ({ mcpHttp: item.mcpHttp, omittedTools: item.omittedTools })))}`
          : "No model request yet. Send a message with this ACP model to inspect its offered OMP tools.", "info");
        return;
      }

      const policy = deps.getToolPolicy();
      const auth = await inspectAcpAuth();
      const authConfigured = auth.status === "api-key-env" || auth.status === "oauth-refreshable" || (await keychain.present()) === true;
      ctx.ui.notify(`Antigravity ACP (OMP adapter)\nAuth storage: ${authConfigured ? "configured (ACP-owned token file, system keyring or macOS keychain)" : auth.status}\nRequested permission mode: ${deps.getPermissionMode()}\nWire permission mode: ${snapshot.permissionMode}\nNative tools: ${policy.nativeTools}\nDebug tool updates: ${policy.debugToolUpdates ? "on" : "off"}\nTool routing: ${JSON.stringify([...deps.connections].map(connection => connection.toolRouting).filter(Boolean))}\nActive sessions: ${snapshot.bindings}\nConfirmed thinking: ${JSON.stringify([...deps.connections].map(connection => connection.confirmedThinking).filter(Boolean))}\nUsage: ${JSON.stringify(snapshot.metrics)}\n${JSON.stringify(snapshot.processes)}`, "info");
    } finally {
      lease.release();
    }
  };
}
