// OMP 18.x adapter for the Antigravity ACP runtime (Pi 1.1 API). The runtime
// itself is owned source under ./runtime; the adapter only translates the
// provider registration contract and OMP-specific behaviour.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyApiCostEstimate } from "./pricing.ts";
import { fetchCliQuota, type AntigravityQuotaSnapshot } from "./usage-accounting.ts";
import { createQuotaUsageProvider } from "./quota-usage.ts";
import { ensureLoopbackBypass } from "./proxy-env.ts";
import {
  inspectRuntimeLaunchPlan,
  quotaSourceForPlan,
  resolveAcpPermissionProfile,
  resolveLaunchTarget,
  resolveRuntimeLaunchPlan,
  type RuntimeLaunchPlan,
} from "./runtime/launch.ts";
import { loadAdapterConfig, resolveAdapterPermissionMode, type AdapterPermissionMode, type EffectivePermissionMode } from "./adapter-config.ts";
import { SessionRuntimePool } from "./runtime-pool.ts";
import { ownerRoutingId, sessionOwnerId } from "./runtime/routing.ts";
import { createStructuredFingerprintMemo } from "./runtime/binding.ts";
import { Diagnostics, instrumentRuntime } from "./diagnostics.ts";
import { stableTools } from "./tool-order.ts";
import type { Context, Message, Tool } from "@earendil-works/pi-ai";
import { toolDeclarations, normalizeOmpSystemDeltas } from "./omp-context.ts";
import { OmpSessionLifecycle, type OmpProviderSessionState } from "./omp-session-lifecycle.ts";
import { DEFAULT_USAGE_MODE, loadContextSettings, type ContextSettings } from "./context-settings.ts";
import { PARTNER_FALLBACK_MODELS, projectCatalog, selectRuntimeModel, type PublicCatalogModel } from "./model-catalog.ts";
import { TranscriptRouting, type RoutingAttempt } from "./transcript-routing.ts";
import { sourceId } from "./omp-session-source.ts";
import { loadToolPolicy } from "./tool-policy.ts";
import type { NativeToolMode } from "./tool-routing.ts";
import {
  MARKER,
  OmpAuthCoordinator,
  antigravityAccountEmail,
  authReady,
  keychain,
  logoutFollow,
  type OmpCommandContext,
} from "./auth-sync.ts";
import { CatalogStore, type ConfiguredCatalogModel } from "./catalog-store.ts";
import { createAntigravityArgumentCompletions, createAntigravityCommandHandler, type AntigravityCompletionItem, type RuntimeBundleView, type ToolAuditSummary } from "./commands.ts";
import { formatCompactionNotice } from "./acp-compaction.ts";
import { classifyAcpFailure } from "./acp-errors.ts";
import {
  AcpSessionStore,
  AntigravityRuntime,
  clearAntigravityCredentials,
  FALLBACK_MODELS,
  PERMISSION_RESULT_KIND,
  PERMISSION_TOOL_NAME,
  PiEventWriter,
  SessionCleanup,
  TierConnection,
  Type,
  createAntigravityProvider,
  loadConfig,
  planToolProjection,
  prepareManagedRuntime,
  usableApiKey,
} from "./runtime.mjs";

export { keychain, logoutFollow };

interface OmpHostApi {
  on: (name: string, handler: (event: unknown, ctx: OmpCommandContext) => unknown) => void;
  registerProvider: (name: string, config: unknown) => void;
  unregisterProvider?: (name: string) => void;
  registerTool: (tool: unknown) => void;
  registerCommand: (name: string, command: {
    description: string;
    handler: (args: string, ctx: OmpCommandContext) => Promise<void>;
    // OMP's autocomplete calls this with the text after "/<name> " and renders
    // the returned items; optional so older hosts simply skip completion.
    getArgumentCompletions?: (args: string) => AntigravityCompletionItem[] | null | Promise<AntigravityCompletionItem[] | null>;
  }) => void;
}

export function resolveAdapterStateDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  // OMP sets this to the active named profile's agent directory during CLI
  // bootstrap; it also honors an explicit default-profile override.
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configured ? configured === "~" ? home
    : configured.startsWith("~/") || configured.startsWith("~\\") ? path.join(home, configured.slice(2))
    : path.resolve(configured)
    : path.join(home, env.PI_CONFIG_DIR || ".omp", "agent");
  return path.join(agentDir, "antigravity-acp-provider");
}

// Offline catalog used before the first ACP discovery. Keep the newest
// families here so a fresh install or an auth gap still exposes them; the
// CatalogStore marks these entries as unverified until a real refresh lands.
export function offlineFallbackModels(): PublicCatalogModel[] {
  return [
    ...FALLBACK_MODELS,
    ...projectCatalog([
      { modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (low)" },
      { modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (medium)" },
      { modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (high)" },
      { modelId: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (low)" },
      { modelId: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen (medium)" },
      { modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (high)" },
      { modelId: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen (xhigh)" },
    ]),
    ...PARTNER_FALLBACK_MODELS,
  ];
}

const defaultConnectionFactory = (options: ConstructorParameters<typeof TierConnection>[0]): TierConnection =>
  new TierConnection(options);

export interface OmpAdapterOptions {
  // An injected factory keeps fixtures offline, so warmup stays opt-in for it:
  // a test exercises the real standby lifecycle without a network spawn.
  warmup?: boolean;
}

// Standby warmup is a latency optimization, never a requirement. `off`, or any
// value this adapter does not recognize, leaves every request on the cold path.
function warmupSetting(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OMP_ACP_WARMUP?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") return false;
  return raw === "on" || raw === "1" || raw === "true" || raw === "yes" || raw === "auto";
}

// The identity a standby must share with a real request before it is reused.
interface WarmupSignature {
  cwd: string;
  target: string;
  autoApprove: boolean;
  nativeTools: NativeToolMode;
  debugToolUpdates: boolean;
  usageMode: "auto" | "off";
}

// Discovery and install can outlive a shutdown request; the standby task stops
// at its next generation check, so teardown only waits this long.
const WARMUP_STOP_TIMEOUT_MS = 2_000;

export default async function (pi: OmpHostApi) {
  return registerOmpAdapter(pi, resolveAdapterStateDir());
}

// Explicit state injection keeps command integration tests away from user data.
export async function registerOmpAdapter(pi: OmpHostApi, stateDir: string,
  createConnection: (options: ConstructorParameters<typeof TierConnection>[0]) => TierConnection = defaultConnectionFactory,
  options: OmpAdapterOptions = {}) {
  const configPath = path.join(stateDir, "config.json");
  const cachePath = path.join(stateDir, "models-cache.json");
  const toolPolicyPath = path.join(stateDir, "omp-tools.json");
  const contextPath = path.join(stateDir, "context.json");
  // Preserve restrictive legacy permissions before merged defaults are derived.
  loadConfig(configPath);
  let legacyContextSettings: ContextSettings;
  try {
    legacyContextSettings = loadContextSettings(contextPath);
  } catch (error) {
    console.warn("[antigravity-acp] Ignoring invalid context settings; using model defaults.", error instanceof Error ? error.message : String(error));
    legacyContextSettings = { defaults: {}, models: {} };
  }
  const legacyToolPolicy = loadToolPolicy(toolPolicyPath);
  const diagnosticsPath = path.join(stateDir, "diagnostics.json");
  const legacyDiagnostics = new Diagnostics(diagnosticsPath);
  const adapterConfig = loadAdapterConfig(configPath, {
    nativeTools: legacyToolPolicy.nativeTools,
    debugToolUpdates: legacyToolPolicy.debugToolUpdates,
    usageMode: legacyContextSettings.defaults.usageMode,
    diagnostics: legacyDiagnostics.status().enabled,
  });
  let contextSettings: ContextSettings = {
    ...legacyContextSettings,
    defaults: { ...legacyContextSettings.defaults, usageMode: adapterConfig.usageMode },
  };
  let toolPolicy = { nativeTools: adapterConfig.nativeTools, debugToolUpdates: adapterConfig.debugToolUpdates };
  let permissionPreference: AdapterPermissionMode = adapterConfig.permissions;
  let permissionMode: EffectivePermissionMode = resolveAdapterPermissionMode(
    permissionPreference, path.dirname(stateDir), process.cwd());
  const sessionStorePath = path.join(stateDir, "sessions.json");
  const sessionStore = new AcpSessionStore(sessionStorePath);
  const cleanup = new SessionCleanup(stateDir);
  const diagnostics = adapterConfig.diagnostics === legacyDiagnostics.status().enabled
    ? legacyDiagnostics
    : new Diagnostics(diagnosticsPath, adapterConfig.diagnostics);
  // Count saved records from disk so /antigravity-acp account needs no runtime.
  let savedSessionCache: { stamp: string; count: number } | undefined;
  const savedSessionCount = (): number => {
    let stamp: string | undefined;
    try {
      const stat = fs.statSync(sessionStorePath);
      stamp = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    } catch { /* Missing or unreadable store: fall through to a fresh read. */ }
    if (stamp !== undefined && savedSessionCache?.stamp === stamp) return savedSessionCache.count;
    let count = 0;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(sessionStorePath, "utf8"));
      if (Array.isArray(parsed)) for (const record of parsed) {
        if (record && typeof record === "object" && "piSessionId" in record && typeof record.piSessionId === "string") count++;
      }
    } catch { return 0; }
    if (stamp !== undefined) savedSessionCache = { stamp, count };
    return count;
  };

  // Loading this global extension must not start ACP or query Google.
  let readiness: Promise<void> | undefined;
  let launchPlan: Promise<RuntimeLaunchPlan | undefined> | undefined;
  let selectedLaunchPlan: RuntimeLaunchPlan | undefined;
  const currentPermissionProfile = () => resolveAcpPermissionProfile(selectedLaunchPlan, permissionMode);
  function prepareRuntime() {
    launchPlan ??= resolveRuntimeLaunchPlan(stateDir).then(plan => {
      selectedLaunchPlan = plan;
      return plan;
    });
    readiness ??= launchPlan.then(async plan => {
      if (!plan) throw new Error("ACP runtime launch plan is not ready.");
      selectedLaunchPlan = await prepareManagedRuntime(plan);
    }).catch((error: unknown) => {
      readiness = undefined;
      launchPlan = undefined;
      selectedLaunchPlan = undefined;
      throw error;
    });
    return readiness;
  }

  // Inference and model discovery must not let the ACP server open an
  // interactive Google consent flow at session/new. A missing local login is a
  // user action, not a reason to leave the submitted message pending. An
  // OMP-stored API key is not guessed at here: the ACP server's advertised
  // api-key method validates the actual secret during session setup. The
  // managed marker is an OMP placeholder, never a substitute credential.
  async function requireAcpAuth(apiKey?: string): Promise<void> {
    if (usableApiKey(apiKey)) return;
    if (await authReady({ allowKeychain: selectedLaunchPlan?.source !== "managed" })) return;
    throw new Error("Antigravity ACP is not signed in. Run /login (or /antigravity-acp login) before sending a message.");
  }

  const connections = new Set<TierConnection>();
  const idleTimeoutMs = Number(process.env.OMP_ACP_IDLE_TIMEOUT_MS ?? 900_000);
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 0 || idleTimeoutMs > 2_147_483_647 || (idleTimeoutMs > 0 && idleTimeoutMs < 1000)) {
    throw new Error("OMP_ACP_IDLE_TIMEOUT_MS must be 0 (disabled) or an integer between 1000 and 2147483647");
  }
  const maxIdleEntries = Number(process.env.OMP_ACP_MAX_IDLE_RUNTIMES ?? 2);
  if (!Number.isSafeInteger(maxIdleEntries) || maxIdleEntries < 0) throw new Error("OMP_ACP_MAX_IDLE_RUNTIMES must be a nonnegative integer (0 disables the cap)");
  const toolProjectionMemo = createStructuredFingerprintMemo();
  let toolRevision = 0;

  let lastToolAudit: ToolAuditSummary | undefined;
  let cachedToolProjection: {
    revision: string;
    tools: Tool[];
    audit: ToolAuditSummary;
  } | undefined;

  // A spawn is described once so warmup and a real request can compare the
  // exact target, cwd, permission process flag and tool policy before a
  // standby is reused.
  interface PreparedSpawn {
    options: ConstructorParameters<typeof TierConnection>[0];
    signature: WarmupSignature;
  }

  function prepareSpawn(options: ConstructorParameters<typeof TierConnection>[0]): PreparedSpawn {
    const profile = currentPermissionProfile();
    const env = ensureLoopbackBypass({
      ...process.env,
      ...options.env,
    });
    if (profile.autoApproveProcess) env.OMP_ACP_DANGEROUSLY_SKIP_PERMISSIONS = "1";
    else delete env.OMP_ACP_DANGEROUSLY_SKIP_PERMISSIONS;
    const identity = {
      cwd: path.resolve(options.cwd ?? process.cwd()),
      autoApprove: profile.autoApproveProcess,
      nativeTools: toolPolicy.nativeTools,
      debugToolUpdates: toolPolicy.debugToolUpdates,
      usageMode: contextSettings.defaults.usageMode ?? DEFAULT_USAGE_MODE,
    } as const;
    // `command`/`entryPath` stay fixture-only direct spawns. An explicit
    // `launch` record comes from an inspected plan (quota) and is already the
    // verified target; inference never supplies it and still resolves and
    // verifies the selected plan below.
    if (options.command !== undefined || options.entryPath !== undefined || options.launch !== undefined) {
      const target = options.launch !== undefined
        ? `launch:${options.launch.command}\u0000${(options.launch.args ?? []).join("\u0000")}`
        : options.command !== undefined
          ? `command:${options.command}\u0000${(options.args ?? []).join("\u0000")}`
          : `entry:${options.entryPath}`;
      return { options: { ...options, env }, signature: { ...identity, target } };
    }
    // The plan owns the spawn target, so the runtime never has to resolve a
    // runtime from shared environment state.
    const plan = selectedLaunchPlan;
    if (!plan) throw new Error("ACP runtime launch plan is not ready; prepare the runtime before spawning ACP.");
    // The verified plan target is spawned through the owned supervisor, so the
    // process tree, Windows batch wrappers and node resolution stay owned.
    const launch = resolveLaunchTarget(plan);
    return {
      options: { ...options, launch, env },
      signature: { ...identity, target: `launch:${launch.command}\u0000${launch.args.join("\u0000")}` },
    };
  }

  // Discovery, quota and fixture callers spawn directly; only the inference
  // path below may consume a warmed standby.
  function spawnConnection(options: ConstructorParameters<typeof TierConnection>[0]): TierConnection {
    const connection = createConnection(prepareSpawn(options).options);
    if (connection.process?.exited) {
      connections.add(connection);
      void connection.process.exited.finally(() => {
        connections.delete(connection);
      });
    }
    return connection;
  }

  // Standby warmup keeps one initialized, session-less ACP connection for the
  // next real binding. It is published only after initialize resolves, is
  // never given a throwaway session, and is closed whenever its target or
  // policy identity changes.
  // An injected factory keeps fixtures offline, so warmup needs the explicit
  // adapter opt-in there; production uses the default factory and the env flag.
  const warmupEnabled = warmupSetting()
    && (createConnection === defaultConnectionFactory || options.warmup === true);
  let warmupStandby: { connection: TierConnection; signature: WarmupSignature } | undefined;
  let warmupTask: Promise<void> | undefined;
  let warmupTaskKey: string | undefined;
  let warmupStarting: TierConnection | undefined;
  let warmupAbort: AbortController | undefined;
  let warmupGeneration = 0;
  // A refresh that settles after shutdown must not restart warmup.
  let warmupEpoch = 0;
  const warmupClosings = new Set<Promise<void>>();

  function closeWarmupConnection(connection: TierConnection): Promise<void> {
    const closing = Promise.resolve().then(() => connection.close()).catch(() => undefined);
    warmupClosings.add(closing);
    void closing.then(() => { warmupClosings.delete(closing); });
    return closing;
  }

  const warmupKeyOf = (signature: Omit<WarmupSignature, "target">): string =>
    [signature.cwd, signature.autoApprove ? "1" : "0", signature.nativeTools,
      signature.debugToolUpdates ? "1" : "0", signature.usageMode].join("\u0000");

  function currentWarmupKey(): string {
    const profile = currentPermissionProfile();
    return warmupKeyOf({
      cwd: path.resolve(process.cwd()),
      autoApprove: profile.autoApproveProcess,
      nativeTools: toolPolicy.nativeTools,
      debugToolUpdates: toolPolicy.debugToolUpdates,
      usageMode: contextSettings.defaults.usageMode ?? DEFAULT_USAGE_MODE,
    });
  }

  function sameWarmupSignature(left: WarmupSignature, right: WarmupSignature): boolean {
    return left.cwd === right.cwd && left.target === right.target && left.autoApprove === right.autoApprove
      && left.nativeTools === right.nativeTools && left.debugToolUpdates === right.debugToolUpdates
      && left.usageMode === right.usageMode;
  }

  // Drop any ready or in-flight standby. The in-flight task sees the generation
  // bump and closes its own connection instead of publishing it.
  function invalidateWarmup(): void {
    warmupGeneration += 1;
    warmupAbort?.abort();
    warmupAbort = undefined;
    warmupTaskKey = undefined;
    const starting = warmupStarting;
    warmupStarting = undefined;
    if (starting) void closeWarmupConnection(starting);
    const ready = warmupStandby;
    warmupStandby = undefined;
    if (ready) void closeWarmupConnection(ready.connection);
  }

  async function runWarmup(generation: number, controller: AbortController): Promise<void> {
    const stale = () => controller.signal.aborted || generation !== warmupGeneration;
    try {
      // A missing login is a user action; warmup must not surface it.
      if (!(await authReady())) return;
      if (stale()) return;
      // Serialized behind the same preparation every request uses, so warmup
      // never duplicates a discovery or install already in flight.
      await prepareRuntime();
      if (stale()) return;
      let prepared: PreparedSpawn;
      try {
        prepared = prepareSpawn({ cwd: process.cwd() });
      } catch {
        // No usable provider target: stay silent and let inference report it.
        return;
      }
      if (stale()) return;
      const connection = createConnection({
        ...prepared.options,
        ompNativeTools: toolPolicy.nativeTools,
        ompDebugToolUpdates: toolPolicy.debugToolUpdates,
        ompUsageMode: contextSettings.defaults.usageMode ?? DEFAULT_USAGE_MODE,
        ompCleanup: cleanup,
        ompDiagnostics: diagnostics,
      });
      warmupStarting = connection;
      try {
        await connection.initialize(controller.signal);
      } catch {
        if (warmupStarting !== connection) return; // A cancel already closed it.
        warmupStarting = undefined;
        await closeWarmupConnection(connection);
        return;
      }
      if (warmupStarting !== connection) return;
      warmupStarting = undefined;
      if (stale() || connection.process?.alive === false) {
        await closeWarmupConnection(connection);
        return;
      }
      warmupStandby = { connection, signature: prepared.signature };
    } catch { /* Warmup is best effort; the cold path remains available. */ }
  }

  function startWarmup(): void {
    if (!warmupEnabled) return;
    const key = currentWarmupKey();
    if (warmupStandby && warmupKeyOf(warmupStandby.signature) === key) return;
    if (warmupTask && warmupTaskKey === key) return;
    invalidateWarmup();
    const generation = ++warmupGeneration;
    const controller = new AbortController();
    warmupAbort = controller;
    warmupTaskKey = key;
    const task = runWarmup(generation, controller);
    warmupTask = task;
    void task.then(() => {
      if (warmupTask === task) { warmupTask = undefined; warmupTaskKey = undefined; }
      if (warmupAbort === controller) warmupAbort = undefined;
    });
  }

  // Only an inference request may consume a standby, and only when every
  // identity field matches. Handlers are rebound in place, never a new
  // transport, and a connection that cannot rebind is closed instead.
  function takeWarmup(
    signature: WarmupSignature,
    handlers: ConstructorParameters<typeof TierConnection>[0]["handlers"],
  ): TierConnection | undefined {
    const ready = warmupStandby;
    // Only a handler-bound binding may take a standby. Login and other
    // purpose-specific transports keep their own environment.
    if (!ready || handlers === undefined) return undefined;
    if (!sameWarmupSignature(ready.signature, signature) || ready.connection.process?.alive === false
      || typeof ready.connection.rebindHandlers !== "function") {
      warmupStandby = undefined;
      void closeWarmupConnection(ready.connection);
      return undefined;
    }
    warmupStandby = undefined;
    ready.connection.rebindHandlers(handlers);
    return ready.connection;
  }

  async function stopWarmup(): Promise<void> {
    warmupEpoch += 1;
    invalidateWarmup();
    const task = warmupTask;
    const pending = [...warmupClosings];
    if (task) pending.push(task.catch(() => undefined));
    if (!pending.length) return;
    // The generation bump already prevents a spawn or publish after this
    // point, so teardown waits finitely instead of following discovery.
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>(resolve => { const timer = setTimeout(resolve, WARMUP_STOP_TIMEOUT_MS); timer.unref?.(); }),
    ]);
  }

  function requestWarmup(): void {
    if (!warmupEnabled) return;
    const epoch = warmupEpoch;
    const start = () => { if (epoch === warmupEpoch) startWarmup(); };
    // The startup refresh already runs a discovery connection. Warm up after
    // it settles so two ACP processes never race for the same state.
    const refresh = startupRefresh;
    if (refresh) void refresh.then(start, start);
    else start();
  }

  // A side routing id shares its parent's runtime entry, so a new one-shot id
  // never spawns a fresh process. Only a full owner close tears it down.
  const lifecycle: OmpSessionLifecycle = new OmpSessionLifecycle(id => runtimes.close(ownerRoutingId(id)), async id => {
    if (id) await cleanup.releaseSession(id);
  }, ownerRoutingId);
  const runtimes: SessionRuntimePool<RuntimeBundleView> = new SessionRuntimePool<RuntimeBundleView>(() => {
    const ownedConnections = new Set<TierConnection>();
    const runtime = new AntigravityRuntime((options: ConstructorParameters<typeof TierConnection>[0]) => {
      const requested = {
        ...options,
        ompNativeTools: toolPolicy.nativeTools,
        ompDebugToolUpdates: toolPolicy.debugToolUpdates,
        ompUsageMode: contextSettings.defaults.usageMode ?? DEFAULT_USAGE_MODE,
        ompCleanup: cleanup,
        ompDiagnostics: diagnostics,
      };
      const prepared = prepareSpawn(requested);
      // A warmed standby is reused only for this exact target, cwd, permission
      // process flag, tool policy and usage mode; otherwise it was closed and
      // this request spawns cold.
      const connection = takeWarmup(prepared.signature, options.handlers) ?? createConnection(prepared.options);
      connections.add(connection);
      ownedConnections.add(connection);
      void connection.process.exited.finally(() => {
        connections.delete(connection);
        ownedConnections.delete(connection);
      });
      return connection;
    }, currentPermissionProfile().wireMode, sessionStore);
    instrumentRuntime(runtime, diagnostics);
    return {
      runtime,
      provider: createAntigravityProvider(runtime).provider,
      isBusy: () => [...ownedConnections].some(connection => connection.activePrompts > 0),
    };
  }, (bundle, id) => lifecycle.disposeRuntime(id, bundle, () => bundle.runtime.close()),
  { timeoutMs: idleTimeoutMs, maxIdleEntries, canDispose: bundle => !bundle.isBusy() });

  // Logout, policy changes and a full shutdown all land here: a standby must
  // never outlive the pool it would serve.
  async function closePool() { await stopWarmup(); await lifecycle.closeAll(); await runtimes.closeAll(); }

  const routing = new TranscriptRouting();
  const sessionIdOf = (ctx: OmpCommandContext | undefined): string | undefined => ctx?.sessionManager?.getSessionId?.();
  pi.on("session_shutdown", async (_event: unknown, ctx: OmpCommandContext) => {
    const failures: unknown[] = [];
    const sessionId = sessionIdOf(ctx);
    if (sessionId) {
      const routingId = routing.forget(sessionId, ctx?.sessionManager?.getSessionFile?.());
      const closing = [lifecycle.closeSession(sessionId), stopWarmup()];
      if (routingId !== sessionId) closing.push(lifecycle.closeSession(routingId));
      const results = await Promise.allSettled([...closing, lifecycle.waitClosing(), runtimes.closeIdle()]);
      for (const result of results) if (result.status === "rejected") failures.push(result.reason);
    } else {
      await closePool();
    }
    await sessionStore.flush().catch(error => { failures.push(error); });
    await Promise.allSettled([
      cleanup.flushStoreNotes(),
      runtimes.values().length ? Promise.resolve() : cleanup.stop(),
    ]).then(results => {
      for (const result of results) if (result.status === "rejected") failures.push(result.reason);
    });
    if (failures.length) throw failures[0];
  });

  function syncProviderRegistration() {
    // Re-registering without an apiKey does not clear OMP's stored key
    // config; unregister first so a logout report finds no remaining
    // "provider config (fallback)" source.
    try { pi.unregisterProvider?.("antigravity-acp"); } catch { /* older hosts */ }
    tryRegisterProvider();
  }

  const auth = new OmpAuthCoordinator({
    pi,
    connections,
    isPoolBusy: () => runtimes.values().some(bundle => bundle.isBusy()),
    logoutAllRuntimes: async () => {
      await Promise.all(runtimes.values().map(bundle => bundle.runtime.logout()));
      // Finish the Antigravity-side cleanup even when the pool is empty,
      // instead of instantiating a runtime just to log it out.
      await sessionStore.clear();
      clearAntigravityCredentials();
    },
    closeAllRuntimes: closePool,
    onSyncProvider: syncProviderRegistration,
  });

  const trackOmpSource = async (_event: unknown, ctx: OmpCommandContext) => {
    const transcriptId = ctx.sessionManager?.getSessionId?.(), file = ctx.sessionManager?.getSessionFile?.();
    if (!transcriptId || !file || transcriptId.includes(":side:")) return;
    const id = routing.take(transcriptId, file);
    try { await cleanup.trackSource(id, file); } catch { /* Unproven or not-yet-persisted sources remain protected. */ }
  };

  const notifyAcpCompactions = async (ctx: OmpCommandContext) => {
    const transcriptId = sessionIdOf(ctx);
    if (!transcriptId) return;
    const saved = await sessionStore.get(ownerRoutingId(transcriptId) ?? transcriptId).catch(() => undefined);
    if (!saved) return;
    for (const connection of connections) {
      for (const notice of connection.takeCompactionNotices?.(saved.acpSessionId) ?? []) {
        try { ctx.ui.notify(formatCompactionNotice(notice), notice.status === "failed" ? "warning" : "info"); }
        catch { /* A notification failure must not affect inference. */ }
      }
    }
  };
  let refreshModelsOnStartup: (() => Promise<void>) | undefined;
  pi.on("session_start", async (event: unknown, ctx: OmpCommandContext) => {
    routing.clearPending();
    auth.watchOmpCredentials(ctx); await trackOmpSource(event, ctx); await notifyAcpCompactions(ctx); cleanup.start();
    await refreshModelsOnStartup?.();
    // The refresh above has settled, so the standby cannot duplicate it.
    requestWarmup();
  });
  pi.on("agent_end", async (event: unknown, ctx: OmpCommandContext) => {
    await trackOmpSource(event, ctx);
    await notifyAcpCompactions(ctx);
  });
  const handleSourceTransition = async (event: unknown, ctx: OmpCommandContext) => {
    routing.clearPending();
    const transcriptId = sessionIdOf(ctx), file = ctx.sessionManager?.getSessionFile?.();
    const eventRecord = typeof event === "object" && event !== null ? event : undefined;
    const reason: unknown = eventRecord ? Reflect.get(eventRecord, "reason") : undefined;
    if ((reason === "new" || reason === "resume" || reason === "fork" || reason === "branch" || reason === "btw")
      && !transcriptId?.includes(":side:")) {
      if (!transcriptId || !file) {
        routing.invalidateUnknownSource();
      } else {
        const candidate: unknown = eventRecord ? Reflect.get(eventRecord, "previousSessionFile") : undefined;
        const previousFile = typeof candidate === "string" ? candidate : undefined;
        const previousTranscriptId = previousFile ? await sourceId(previousFile).catch(() => undefined) : undefined;
        routing.noteSourceSwitch(reason, transcriptId, file, previousTranscriptId, previousFile);
      }
    }
    await trackOmpSource(event, ctx);
    await notifyAcpCompactions(ctx);
  };
  pi.on("session_switch", handleSourceTransition);
  pi.on("session_branch", handleSourceTransition);

  pi.registerTool({
    name: PERMISSION_TOOL_NAME,
    label: "Antigravity ACP Permission",
    description: "Answer a pending Antigravity permission request.",
    parameters: Type.Object({ requestId: Type.String({ minLength: 1 }) }),
    async execute(_id: string, params: { requestId: string }, _signal: unknown, _update: unknown, ctx: OmpCommandContext) {
      const request = runtimes.values().map(bundle => bundle.runtime.getPermission(params.requestId)).find(Boolean);
      if (!request) throw new Error("Permission request expired or missing");
      const labels = request.options.map((option: { label: string }) => option.label);
      const selected = await ctx.ui.select?.(request.title, labels);
      const optionId = selected !== undefined ? request.options[labels.indexOf(selected)]?.id : undefined;
      return {
        content: [{ type: "text", text: optionId ? `Permission: ${selected}` : "Permission denied." }],
        details: { kind: PERMISSION_RESULT_KIND, requestId: request.id, optionId, cancelled: !optionId },
      };
    },
  });

  const catalogStore = new CatalogStore(
    cachePath,
    cleanup,
    prepareRuntime,
    offlineFallbackModels,
    requireAcpAuth,
    spawnConnection,
  );
  let initialModels: ConfiguredCatalogModel[];
  try {
    initialModels = catalogStore.loadInitialOrCached(contextSettings);
  } catch (error) {
    console.warn("[antigravity-acp] Context budgets do not fit the catalog; using model defaults.", error instanceof Error ? error.message : String(error));
    contextSettings = { defaults: { usageMode: contextSettings.defaults.usageMode }, models: {} };
    try {
      initialModels = catalogStore.loadInitialOrCached(contextSettings);
    } catch {
      initialModels = catalogStore.projectWithSettings(offlineFallbackModels(), contextSettings, false);
    }
  }

  // A model selection is the first moment the next turn's target is known.
  // Only this provider's selection warms; another provider's selection must
  // never spawn an ACP process.
  const isAntigravitySelection = (event: unknown): boolean => {
    if (typeof event !== "object" || event === null) return false;
    const model: unknown = Reflect.get(event, "model");
    const modelRecord = typeof model === "object" && model !== null ? model : undefined;
    const provider = Reflect.get(event, "provider") ?? Reflect.get(event, "providerId")
      ?? (modelRecord ? Reflect.get(modelRecord, "provider") ?? Reflect.get(modelRecord, "api") : undefined);
    if (typeof provider === "string" && provider.length > 0) return provider === "antigravity-acp";
    const id = Reflect.get(event, "modelId") ?? (modelRecord ? Reflect.get(modelRecord, "id") : undefined);
    return typeof id === "string"
      && (catalogStore.upstreamModels.has(id) || catalogStore.currentModels.some(candidate => candidate.id === id));
  };
  pi.on("model_select", (event: unknown) => {
    if (isAntigravitySelection(event)) requestWarmup();
  });

  async function loadQuotaSnapshot(signal?: AbortSignal): Promise<AntigravityQuotaSnapshot | undefined> {
    // Derive quota from the plan that inference will spawn. Before the plan
    // exists, inspect the same order without writing a wrapper or a record.
    const plan = selectedLaunchPlan ?? await inspectRuntimeLaunchPlan(stateDir, { signal }).catch(() => undefined);
    const source = plan ? quotaSourceForPlan(plan) : undefined;
    if (!plan || !source) return undefined;
    if (source.kind === "cli") return fetchCliQuota(source.cliPath, signal);
    // Quota keeps the local-login credential route: OMP's usage provider has no
    // credential parameter, so an OMP-stored API key is not forwarded here.
    if (!(await authReady())) return undefined;
    // The short-lived ACP session uses the exact verified launch record from the
    // same plan as inference, never a direct fixture-style command.
    const launch = resolveLaunchTarget(plan);
    const runtime = new AntigravityRuntime(
      options => spawnConnection({ ...options, launch, ompCleanup: cleanup }),
      currentPermissionProfile().wireMode,
    );
    try {
      return await runtime.quota(undefined, signal);
    } finally {
      await runtime.close();
    }
  }
  const quotaUsageProvider = createQuotaUsageProvider({
    loadSnapshot: loadQuotaSnapshot,
    modelIds: () => catalogStore.currentModels.map(model => model.id),
  });

  pi.registerCommand("antigravity-acp", {
    description: "Inspect ACP status/account/usage/context/cleanup, manage Antigravity login/logout, configure budgets, refresh models or set tool policies",
    handler: createAntigravityCommandHandler({
      configPath,
      contextPath,
      toolPolicyPath,
      cleanup,
      connections,
      auth,
      catalog: catalogStore,
      prepareRuntime,
      getContextSettings: () => contextSettings,
      // A standby carries the policy it was warmed under; any policy or
      // permission change evicts it so the next turn negotiates fresh state.
      setContextSettings: next => { contextSettings = next; invalidateWarmup(); },
      getToolPolicy: () => toolPolicy,
      setToolPolicy: next => { toolPolicy = next; invalidateWarmup(); },
      setPermissionModeState: mode => {
        permissionPreference = mode as AdapterPermissionMode;
        permissionMode = resolveAdapterPermissionMode(permissionPreference, path.dirname(stateDir), process.cwd());
        invalidateWarmup();
      },
      getRuntimeForSession: sessionId => runtimes.get(sessionId),
      acquireRuntimeForSession: sessionId => runtimes.acquire(sessionId),
      peekRuntimeForSession: sessionId => runtimes.peek(sessionId),
      getSavedSessionCount: savedSessionCount,
      getPermissionMode: () => permissionMode,
      getPermissionPreference: () => permissionPreference,
      getAllRuntimes: () => runtimes.values(),
      closeAllRuntimes: closePool,
      onModelsUpdated: models => {
        initialModels = models;
        registerProvider();
      },
    }),
    getArgumentCompletions: createAntigravityArgumentCompletions({ catalog: catalogStore }),
  });

  function tryRegisterProvider(): void {
    try {
      registerProvider();
    } catch {
      return;
    }
  }

  function registerProvider(): void {
    pi.registerProvider("antigravity-acp", {
        api: "antigravity-acp",
        baseUrl: "acp://antigravity",
        // A config apiKey keeps OMP's own logout report claiming a remaining
        // "provider config (fallback)" source, but dropping it entirely hides
        // the catalog before the first /login. Register it only while an OMP
        // marker is known to exist or before any logout was observed.
        apiKey: auth.apiKeyFallback ? MARKER : undefined,
        models: initialModels,
        usage: quotaUsageProvider,
        async fetchDynamicModels() {
          // OMP may call this during startup, even for another provider.
          // Network discovery is reserved for explicit refresh or first ACP use.
          return catalogStore.getDynamicModels(contextSettings);
        },
        streamSimple(
          model: { id: string },
          context: { tools?: Tool[]; systemPrompt?: string | string[]; messages: Message[] },
          options?: { apiKey?: string; sessionId?: string; parentSessionId?: string; promptCacheKey?: string; reasoning?: string; signal?: AbortSignal; providerSessionState?: Map<string, OmpProviderSessionState> },
        ) {
          const inputTools = toolDeclarations(context.tools ?? []);
          let tools: Tool[];
          const cached = cachedToolProjection;
          const revision = toolProjectionMemo(inputTools, () => String(++toolRevision));
          // Validate live definitions, including mutation of the same array.
          if (cached && cached.revision === revision) {
            tools = cached.tools;
            lastToolAudit = cached.audit;
          } else {
            tools = stableTools(inputTools);
            const bridged = tools.filter(tool => tool.name !== PERMISSION_TOOL_NAME);
            const omitted: Array<{ name: string; reason: string }> = planToolProjection(tools);
            const omittedNames = new Set(omitted.map(tool => tool.name));
            const available = bridged.filter(tool => !omittedNames.has(tool.name));
            lastToolAudit = {
              offered: bridged.map(tool => tool.name),
              available: available.map(tool => tool.name),
              omitted,
            };
            cachedToolProjection = { revision, tools, audit: lastToolAudit };
          }
          const routedContext: Context = {
            ...context,
            tools,
            messages: normalizeOmpSystemDeltas(context.messages),
            // Preserve OMP's complete instruction. Projection guidance and the
            // task-to-pi_task mapping travel through the ACP system-append
            // channel once per session; no duplicate paragraph belongs here.
            systemPrompt: Array.isArray(context.systemPrompt) ? context.systemPrompt.join("\n\n") : context.systemPrompt,
          };
          if (process.env.OMP_ACP_TRACE === "1") {
            console.error("[ACP tools]", JSON.stringify(lastToolAudit));
          }
          // OMP needs a stream synchronously. Defer runtime setup behind it so
          // loading/selecting/listing models performs no ACP process activity.
          const deferred = new PiEventWriter(model);
          const routingId = options?.sessionId;
          const ownerId = sessionOwnerId(routingId, options?.parentSessionId);
          let replacedOwner: OmpProviderSessionState | undefined;
          const ticket = lifecycle.capture(routingId, options?.providerSessionState,
            previous => { replacedOwner = previous; });
          const routingAttempt: RoutingAttempt | undefined = routing.noteStream(routingId, ticket.scope, replacedOwner);
          let routingFailed = false;
          void (async () => {
            try {
              if (options?.signal?.aborted) throw new Error("ACP request cancelled before startup");
              await lifecycle.ready(ticket);
              await requireAcpAuth(options?.apiKey);
              await diagnostics.measure("runtime.prepare", prepareRuntime);
              if (options?.signal?.aborted) throw new Error("ACP request cancelled during startup");
              // Discovery uses the same request credential inference will send;
              // the server validates it through its advertised api-key method.
              if (!catalogStore.upstreamModels.has(model.id) && !catalogStore.hasUpstreamCatalog) {
                // Publish the first real discovery result to this host instead
                // of only filling the lookup map; otherwise the model selector
                // keeps the offline effort list until the next restart.
                initialModels = await catalogStore.refresh(contextSettings, options?.apiKey);
                tryRegisterProvider();
              }
              if (options?.signal?.aborted) throw new Error("ACP request cancelled during startup");
              const original = catalogStore.upstreamModels.get(model.id);
              if (!original) throw new Error(`Antigravity model was not discovered: ${model.id}. Run /antigravity-acp refresh.`);
              await lifecycle.ready(ticket);
              const lease = runtimes.acquire(ownerId);
              const { runtime, provider } = lease.value;
              try {
                lifecycle.attach(ticket, lease.value);
                await runtime.setPermissionMode(currentPermissionProfile().wireMode);
                const stream = provider.streamSimple(selectRuntimeModel(original, options?.reasoning), routedContext, { ...options, sessionId: routingId });
                for await (const event of stream) {
                  const message = "message" in event ? event.message : "partial" in event ? event.partial : undefined;
                  if (message?.usage) applyApiCostEstimate(model.id, message.usage, message.timestamp ?? Date.now());
                  deferred.stream.push(event);
                }
                if (process.env.OMP_ACP_TRACE === "1") {
                  try {
                    const snapshot = await runtime.snapshot();
                    console.error("[ACP bridge]", JSON.stringify(snapshot.processes.map((item: { mcpHttp: boolean; omittedTools: unknown[] }) => ({ mcpHttp: item.mcpHttp, omittedTools: item.omittedTools }))));
                  } catch { /* Trace output must never fail a completed turn. */ }
                }
                deferred.stream.end();
                routing.noteSuccess(routingAttempt);
              } finally { lease.release(); }
            } catch (error) {
              routingFailed = true;
              deferred.fail(classifyAcpFailure(error), options?.signal?.aborted === true);
            } finally {
              if (routingFailed) routing.noteFailure(routingAttempt);
              lifecycle.finish(ticket);
            }
          })();
          return deferred.stream;
        },
        oauth: {
          name: "Google Antigravity (ACP)",
          async login(callbacks: {
            signal?: AbortSignal;
            onAuth: (info: { url: string; instructions?: string }) => void;
            onProgress?: (message?: string) => void;
            onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
          }) {
            await prepareRuntime();
            // Always offer a fresh Google sign-in; without this a new server
            // process silently reuses the saved login and keeps the old account.
            const loginAttempt = await auth.beginFreshGoogleLogin();
            try {
              const lease = runtimes.acquire();
              try {
                const result = await lease.value.provider.auth.oauth.login({
                  signal: callbacks.signal,
                  notify(event: { message?: string; links?: Array<{ url: string }> }) {
                    if (event.links?.length) {
                      for (const link of event.links) callbacks.onAuth({ url: link.url, instructions: event.message });
                    } else callbacks.onProgress?.(event.message);
                  },
                  prompt: (request: { message: string; placeholder?: string }) => callbacks.onPrompt({ message: request.message, placeholder: request.placeholder }),
                });
                auth.noteLoginSucceeded(loginAttempt);
                // Record the signed-in account on the marker credential so OMP's
                // account list can label it; the email is identity data, not a secret.
                const email = antigravityAccountEmail();
                return email ? { ...result, email } : result;
              } finally {
                lease.release();
              }
            } catch (error) {
              auth.cancelFreshGoogleLogin(loginAttempt);
              throw error;
            }
          },
          refreshToken: async (credentials: unknown) => {
            // A refresh can be the first thing that needs a connection, and
            // every spawn uses the resolved launch plan.
            await prepareRuntime();
            const lease = runtimes.acquire();
            try {
              return await lease.value.provider.auth.oauth.refresh(credentials);
            } finally {
              lease.release();
            }
          },
          getApiKey: () => MARKER,
        },
    });
  }
  registerProvider();

  let startupRefresh: Promise<void> | undefined;
  refreshModelsOnStartup = () => {
    if (startupRefresh) return startupRefresh;
    // Best effort: a missing login or ACP startup failure must not break the
    // session. The explicit refresh command remains available.
    startupRefresh = catalogStore.refresh(contextSettings)
      .then(models => {
        initialModels = models;
        registerProvider();
      })
      .catch(() => { /* Keep the cached catalog. */ });
    return startupRefresh;
  };
}
