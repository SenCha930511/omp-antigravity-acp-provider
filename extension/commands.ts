import { describeCredentialStorage, inspectAntigravityAuth } from "./runtime.mjs";
import { saveAdapterPermissionMode, updateAdapterConfig, type AdapterPermissionMode } from "./adapter-config.ts";
import { antigravityAccountEmail, authReady, formatLogoutSummary, keychain, ompCredentialSummary, type OmpAuthCoordinator, type OmpCommandContext } from "./auth-sync.ts";
import { parseNativeToolMode, type NativeToolMode } from "./tool-routing.ts";
import { saveToolPolicy, type ToolPolicy } from "./tool-policy.ts";
import { DEFAULT_USAGE_MODE, updateContextSettings, resolveContextOptions, saveContextSettings, type ContextSettings } from "./context-settings.ts";
import type { CatalogStore, ConfiguredCatalogModel } from "./catalog-store.ts";
import type { SessionCleanup, CleanupMode } from "./session-cleanup.ts";
import type { Diagnostics } from "./diagnostics.ts";
import type { TierConnection } from "./tier-connection.ts";
import type { AntigravityQuotaSnapshot } from "./usage-accounting.ts";

export interface RuntimeSnapshotProcess {
  mcpHttp: boolean;
  omittedTools: ToolAuditSummary["omitted"];
  key?: string;
  modelId?: string;
  agentVersion?: string;
  alive?: boolean;
  ignoredStdoutNoiseLines?: number;
  [key: string]: unknown;
}

export interface RuntimeSnapshotView {
  bindings: number;
  permissionMode: string;
  metrics: {
    totals?: Partial<Record<"turns" | "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite", number>>;
    latestQuota?: { remaining?: number; limit?: number; resetAt?: string; tier?: string; model?: string };
  };
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
    quota: (apiKey: string | undefined, signal?: AbortSignal) => Promise<AntigravityQuotaSnapshot>;
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
  { name: "quota", description: "Live model quota groups and reset times" },
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
    values: [["prefer", "Let OMP tools shadow ACP natives (default)"], ["disabled", "Disable ACP-native tools for strict OMP-tool sessions"]],
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

type DisplayField = readonly [label: string, value: string | number | undefined];

function section(title: string, fields: DisplayField[]): string {
  const visible = fields.filter((field): field is readonly [string, string | number] => field[1] !== undefined);
  const width = Math.max(0, ...visible.map(([label]) => label.length));
  return [title, ...visible.map(([label, value]) =>
    `  ${`${label}:`.padEnd(width + 1)} ${typeof value === "number" ? formatNumber(value) : value}`)].join("\n");
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function formatBytes(value: number): string {
  if (value === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${formatNumber(value / 1024 ** exponent)} ${units[exponent]}`;
}

function formatDays(value: number): string {
  return `${formatNumber(value)} ${value === 1 ? "day" : "days"}`;
}

function formatContextValue(key: string, value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return key.endsWith("Bytes") ? formatBytes(value) : `${formatNumber(value)} tokens`;
}

function formatUsageRecord(metrics: RuntimeSnapshotView["metrics"]): string | undefined {
  const totals = metrics.totals;
  if (!totals) return undefined;
  const parts = (["turns", "input", "output", "reasoning", "cacheRead", "cacheWrite"] as const)
    .filter(key => (totals[key] ?? 0) > 0)
    .map(key => `${formatNumber(totals[key]!)} ${key === "cacheRead" ? "cache read" : key === "cacheWrite" ? "cache write" : key}`);
  return parts.length ? parts.join(" · ") : "no completed turns";
}

function formatLatestQuota(quota: NonNullable<RuntimeSnapshotView["metrics"]["latestQuota"]>): string | undefined {
  const parts = [
    quota.tier,
    quota.model,
    quota.remaining !== undefined || quota.limit !== undefined
      ? `${quota.remaining === undefined ? "unknown" : formatNumber(quota.remaining)}${quota.limit === undefined ? "" : ` / ${formatNumber(quota.limit)}`} remaining`
      : undefined,
    quota.resetAt ? `reset ${quota.resetAt}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : undefined;
}

interface DiagnosticsStatusView {
  enabled: boolean;
  samples: number;
  capacity: number;
  stages: Record<string, { count: number; medianMs: number; maxMs: number }>;
}

function formatDiagnostics(status: DiagnosticsStatusView | undefined): string {
  const fields: DisplayField[] = [["Collection", status?.enabled ? "on" : "off"]];
  if (status?.samples) fields.push(["Samples", `${formatNumber(status.samples)} / ${formatNumber(status.capacity)}`]);
  for (const [stage, sample] of Object.entries(status?.stages ?? {})) {
    fields.push([stage, `count ${formatNumber(sample.count)} · median ${formatNumber(sample.medianMs)} ms · max ${formatNumber(sample.maxMs)} ms`]);
  }
  return section("ACP diagnostics", fields);
}

interface CleanupStatusView {
  mode: CleanupMode;
  idleDays: number;
  maxSessions?: number;
  maxBytes?: number;
  orphanGraceDays?: number;
  recoveryDays?: number;
  owned: number;
  active: number;
  mapped: number;
  unmapped: number;
  ownedBytes: number;
  reclaimedBytes: number;
  retainedForRecovery: number;
  deferred: number;
  pendingLifecycleUpdates: number;
  failures: number;
  warning?: string;
  scope: string;
}

function formatCleanup(status: CleanupStatusView, removed: number): string {
  const fields: DisplayField[] = [
    ["Mode", status.mode],
    ["Idle retention", status.idleDays === undefined ? undefined : formatDays(status.idleDays)],
    ["Orphan retention", status.orphanGraceDays === undefined ? undefined : formatDays(status.orphanGraceDays)],
    ["Recovery", status.recoveryDays === undefined ? undefined : formatDays(status.recoveryDays)],
    ["Session budget", status.maxSessions === undefined ? undefined : status.maxSessions === 0 ? "disabled" : status.maxSessions],
    ["Byte budget", status.maxBytes === undefined ? undefined : status.maxBytes === 0 ? "disabled" : formatBytes(status.maxBytes)],
    ["Owned sessions", status.owned || undefined],
    ["Active sessions", status.active || undefined],
    ["Mapped sessions", status.mapped || undefined],
    ["Unmapped sessions", status.unmapped || undefined],
    ["Stored data", status.ownedBytes ? formatBytes(status.ownedBytes) : undefined],
    ["Removed this run", removed],
    ["Reclaimed", status.reclaimedBytes ? formatBytes(status.reclaimedBytes) : undefined],
    ["Retained for recovery", status.retainedForRecovery || undefined],
    ["Deferred", status.deferred || undefined],
    ["Pending updates", status.pendingLifecycleUpdates || undefined],
    ["Failures", status.failures || undefined],
    ["Warning", status.warning],
    ["Scope", status.scope],
    ["Risk", "Active sessions are protected. Timeout cleanup loses ACP-only state; OMP history is retained."],
  ];
  return section("ACP session cleanup", fields);
}

function formatQuota(snapshot: AntigravityQuotaSnapshot): string {
  const groups = snapshot.groups.map(group => {
    const width = Math.max(0, ...group.buckets.map(bucket => bucket.window.length));
    return [
      `  ${group.displayName}`,
      ...(group.buckets.length ? group.buckets.map(bucket =>
        `    ${bucket.window.padEnd(width)}  ${Math.round(bucket.remainingFraction * 100)}% remaining${bucket.resetTime ? ` · reset ${bucket.resetTime}` : ""}`)
        : ["    no percentage limits reported"]),
    ].join("\n");
  });
  return ["Antigravity quota", ...groups].join("\n");
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
      else if (value) {
        updateAdapterConfig(deps.configPath, { diagnostics: value === "on" });
        deps.diagnostics?.configure(value === "on");
      }
      ctx.ui.notify(formatDiagnostics(deps.diagnostics?.status()), "info");
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
      }
      deps.cleanup.start();
      const removed = await deps.cleanup.collect();
      ctx.ui.notify(formatCleanup(deps.cleanup.status(), removed), "info");
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
        if (key === "usageMode") updateAdapterConfig(deps.configPath, { usageMode: raw as "auto" | "off" });
        deps.setContextSettings(next);
        if (key === "usageMode") {
          for (const connection of deps.connections) connection.configureUsage(raw as "auto" | "off");
        }
        deps.onModelsUpdated(deps.catalog.reconfigure(next));
        ctx.ui.notify("ACP context settings saved. Restart OMP or reselect the model to refresh its displayed limits.", "info");
      } else if (value) {
        throw new Error("Usage: /antigravity-acp context [set default|MODEL KEY NUMBER]");
      } else {
        const sections: string[] = [];
        const shared = Object.entries(currentSettings.defaults).map(([key, value]) =>
          [key, formatContextValue(key, value)] as DisplayField).filter(field => field[1] !== undefined);
        sections.push(shared.length ? section("Shared defaults", shared)
          : "Shared defaults\n  Catalog values; no saved overrides.");
        for (const model of deps.catalog.currentModels) {
          const effective = resolveContextOptions(model, currentSettings);
          const overrides = Object.entries(currentSettings.models[model.id] ?? {}).map(([key, value]) =>
            `${key}=${formatContextValue(key, value)}`).join(", ");
          sections.push(section(model.id, [
            ["Context window", formatContextValue("contextWindow", effective.contextWindow)],
            ["Output limit", formatContextValue("maxTokens", effective.maxTokens)],
            ["Reply reserve", formatContextValue("reserveTokens", effective.reserveTokens)],
            ["Input budget", formatContextValue("inputTokenBudget", effective.inputTokenBudget)],
            ["Transfer limit", formatContextValue("maxTransferBytes", effective.maxTransferBytes)],
            ["Image limit", formatContextValue("maxImageBytes", effective.maxImageBytes)],
            ["Overrides", overrides || undefined],
          ]));
        }
        if (!deps.catalog.currentModels.length) sections.push("Models\n  None cached; run /antigravity-acp refresh.");
        ctx.ui.notify(["ACP context settings", ...sections].join("\n\n"), "info");
      }
      return;
    }

    if (command === "usage" && value) {
      if (parts.length !== 2 || (value !== "auto" && value !== "off")) throw new Error("Usage: /antigravity-acp usage [auto|off]");
      const next = updateContextSettings(deps.getContextSettings(), "default", "usageMode", value);
      saveContextSettings(deps.contextPath, next);
      updateAdapterConfig(deps.configPath, { usageMode: value });
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
      updateAdapterConfig(deps.configPath, { debugToolUpdates: enabled });
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
      updateAdapterConfig(deps.configPath, { nativeTools: mode });
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
      const permissionMode = deps.getPermissionMode();
      const omp = ompCredentialSummary(ctx);
      const accountEmail = antigravityAccountEmail();
      const marker = omp.present === undefined ? "unknown; host did not expose the credential store"
        : omp.present ? `present · ${omp.record} · authorized ${omp.authorizedAt ?? "unknown time"}${omp.email && omp.email !== accountEmail ? ` · account ${omp.email}` : ""}`
        : "not stored; run /login or /antigravity-acp login";
      const fields: DisplayField[] = [
        ["Google account", accountEmail ?? ((await keychain.present()) === true ? "signed in · keychain token; email unavailable" : "not signed in")],
        ["ACP authentication", `${auth.status}${auth.authType ? ` · ${auth.authType}` : ""}`],
        ["Credential storage", describeCredentialStorage()],
        ["OMP login marker", marker],
        ["OMP auth source", ompSource],
        ["Saved ACP sessions", deps.getSavedSessionCount()],
        ["Permission", permissionMode === "auto_edit" ? "auto-edit" : permissionMode],
        ["Active sessions", snapshot?.bindings ?? 0],
        ["Token ownership", "Google OAuth tokens stay in Antigravity-owned storage; OMP stores only a non-secret marker."],
        ["Logout", "/antigravity-acp logout clears both sides; OMP /logout also finishes Antigravity-side cleanup."],
      ];
      const ompEmail = "email" in omp ? omp.email : undefined;
      const ompError = "error" in omp ? omp.error : undefined;
      if (ompError) fields.push(["OMP warning", ompError]);
      if (accountEmail && ompEmail && ompEmail !== accountEmail) {
        fields.push(["Account warning", "The OMP marker and Antigravity token identify different accounts."]);
      }
      ctx.ui.notify(section("Antigravity ACP account", fields), "info");
      return;
    }

    if (command === "quota") {
      if (value !== undefined) throw new Error("Usage: /antigravity-acp quota");
      await deps.prepareRuntime();
      const lease = deps.acquireRuntimeForSession
        ? deps.acquireRuntimeForSession(sessionIdOf(ctx))
        : { value: deps.getRuntimeForSession(sessionIdOf(ctx)), release: () => {} };
      try {
        const quota = await lease.value.runtime.quota(undefined).then(formatQuota,
          (error: unknown) => section("Antigravity quota", [
            ["Status", "unavailable"],
            ["Reason", error instanceof Error ? error.message : String(error)],
          ]));
        ctx.ui.notify(quota, "info");
      } finally {
        lease.release();
      }
      return;
    }

    if (command === "usage") {
      const currentSettings = deps.getContextSettings();
      const configured = currentSettings.defaults.usageMode ?? DEFAULT_USAGE_MODE;
      const overridden = process.env.OMP_ACP_USAGE === "off";
      const effective = overridden ? "off" : configured;
      const sections = [section("ACP usage", [["Queries", `${configured} → ${effective}${overridden ? " · OMP_ACP_USAGE=off override" : ""}`]])];
      let visibleConnections = 0;
      for (const connection of deps.connections) {
        const fields: DisplayField[] = [];
        for (const [sessionId, usage] of connection.contextUsage) {
          const ompWindow = connection.getOmpContextWindow?.(sessionId);
          fields.push([`Context ${sessionId}`, `${formatNumber(usage.used)} / ${formatNumber(usage.size)} ACP tokens${ompWindow === undefined ? "" : ` · OMP window ${formatNumber(ompWindow)}`}`]);
        }
        for (const records of connection.compactions.values()) {
          for (const record of records.values()) {
            fields.push([`Compaction ${record.sessionId}/${record.compactionId}`, record.status]);
            if (record.error) fields.push([`Compaction error ${record.compactionId}`, record.error]);
          }
        }
        for (const [sessionId, accounting] of connection.usageStatus) {
          fields.push([`Accounting ${sessionId}`, `${accounting.source} · cache ${accounting.cache}`]);
          if (accounting.error) fields.push([`Accounting error ${sessionId}`, accounting.error]);
        }
        if (connection.activePrompts) fields.push(["Active prompts", connection.activePrompts]);
        if (fields.length) sections.push(section(`Connection ${++visibleConnections}`, fields));
      }
      ctx.ui.notify(sections.join("\n\n"), "info");
      return;
    }

    if (command === "refresh") {
      if (value !== undefined) throw new Error("Usage: /antigravity-acp refresh");
      const refreshed = await deps.catalog.refresh(deps.getContextSettings());
      deps.onModelsUpdated(refreshed);
      ctx.ui.notify(section("ACP model cache refreshed", [["Models", refreshed.length ? refreshed.map(model => model.id).join(", ") : "none advertised"]]), "info");
      return;
    }

    if (command === "permissions") {
      if (!value || !["default", "auto-edit", "yolo"].includes(value) || parts.length > 2) {
        throw new Error("Usage: /antigravity-acp permissions default|auto-edit|yolo");
      }
      const mode = value.replace("-", "_");
      if (mode !== deps.getPermissionMode()) {
        saveAdapterPermissionMode(mode as AdapterPermissionMode, deps.configPath);
        deps.setPermissionModeState(mode);
        await deps.closeAllRuntimes();
      }
    }
    const usageError = "Usage: /antigravity-acp [status|account|login|logout|tools|usage|quota|context|cleanup|diagnostics|debug|native-tools|permissions|refresh]";
    if (command && command !== "status" && command !== "tools" && command !== "permissions") {
      throw new Error(usageError);
    }
    if (command === "status" && value !== undefined) throw new Error(usageError);
    if (command === "tools" && value !== undefined) throw new Error("Usage: /antigravity-acp tools");

    // Tools and status inspect a runtime snapshot. Quota owns a separate
    // query lifecycle above; the other earlier commands stay offline.
    const lease = deps.acquireRuntimeForSession
      ? deps.acquireRuntimeForSession(sessionIdOf(ctx))
      : { value: deps.getRuntimeForSession(sessionIdOf(ctx)), release: () => {} };
    try {
      const snapshot = await lease.value.runtime.snapshot();
      if (command === "tools") {
        const lastToolAudit = deps.getLastToolAudit();
        if (!lastToolAudit) {
          ctx.ui.notify("No model request yet. Send a message with this ACP model to inspect its offered OMP tools.", "info");
          return;
        }
        const sections = [section("OMP ACP tool bridge", [
          ["Offered", lastToolAudit.offered.length],
          ["Available", lastToolAudit.available.join(", ") || "none"],
          ["Omitted", lastToolAudit.omitted.length || undefined],
        ])];
        if (lastToolAudit.omitted.length) {
          sections.push(section("Omitted OMP tools", lastToolAudit.omitted.map((tool): DisplayField => [tool.name, tool.reason])));
        }
        snapshot.processes.forEach((process, index) => {
          const name = process.modelId ?? process.key ?? `Runtime ${index + 1}`;
          sections.push(section(name, [
            ["MCP over HTTP", process.mcpHttp ? "yes" : "no"],
            ...process.omittedTools.map(tool => [`Omitted ${tool.name}`, tool.reason] as DisplayField),
          ]));
        });
        ctx.ui.notify(sections.join("\n\n"), "info");
        return;
      }

      const policy = deps.getToolPolicy();
      const requestedPermission = deps.getPermissionMode();
      const requestedLabel = requestedPermission === "auto_edit" ? "auto-edit" : requestedPermission;
      const wireLabel = snapshot.permissionMode === "auto_edit" ? "auto-edit" : snapshot.permissionMode;
      const versions = [...new Set(snapshot.processes.map(process => process.agentVersion).filter((version): version is string => Boolean(version)))];
      const channels = [...new Set([...deps.connections].map(connection => connection.toolRouting?.channel).filter((channel): channel is "pending" | "system-append" | "legacy-prompt" => Boolean(channel)))];
      const thinking = [...deps.connections].map(connection => connection.confirmedThinking).filter((value): value is { model: string; effort: string } => Boolean(value));
      const stopped = snapshot.processes.filter(process => process.alive === false).length;
      const ignoredNoise = snapshot.processes.reduce((total, process) => total + (process.ignoredStdoutNoiseLines ?? 0), 0);
      ctx.ui.notify(section("Antigravity ACP (OMP adapter)", [
        ["Login", (await authReady()) ? "ready" : `not ready · ${inspectAntigravityAuth().status}`],
        ["Runtime", versions.join(", ") || undefined],
        ["Native channel", channels.join(", ") || undefined],
        ["Permission", requestedLabel === wireLabel ? requestedLabel : `requested ${requestedLabel} → wire ${wireLabel}`],
        ["Native tools", policy.nativeTools],
        ["Tool debug", policy.debugToolUpdates ? "on" : undefined],
        ["Thinking", thinking.map(value => `${value.model}=${value.effort}`).join(", ") || undefined],
        ["Usage record", formatUsageRecord(snapshot.metrics)],
        ["Latest quota", snapshot.metrics.latestQuota ? formatLatestQuota(snapshot.metrics.latestQuota) : undefined],
        ["Active sessions", snapshot.bindings],
        ["Runtime warning", stopped ? `${stopped} stopped process${stopped === 1 ? "" : "es"}` : undefined],
        ["API warning", ignoredNoise ? `${formatNumber(ignoredNoise)} ignored stdout noise line${ignoredNoise === 1 ? "" : "s"}` : undefined],
      ]), "info");
    } finally {
      lease.release();
    }
  };
}
