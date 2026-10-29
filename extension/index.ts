// OMP 18.x adapter for pi-antigravity-acp-provider 0.1.15 (Pi 1.1 API).
// Keep upstream code intact; translate only the provider registration contract.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyApiCostEstimate } from "./pricing.ts";
import { SessionRuntimePool } from "./runtime-pool.ts";
import { createStructuredFingerprintMemo } from "./structured-fingerprint.ts";
import { Diagnostics, instrumentRuntime } from "./diagnostics.ts";
import { stableTools } from "./tool-order.ts";
import { loadContextSettings } from "./context-settings.ts";
import { selectRuntimeModel, type PublicCatalogModel } from "./model-catalog.ts";
import { TOOL_ROUTING } from "./tool-routing.ts";
import { loadToolPolicy } from "./tool-policy.ts";
import {
  MARKER,
  OmpAuthCoordinator,
  antigravityAccountEmail,
  keychain,
  logoutFollow,
  type OmpCommandContext,
} from "./auth-sync.ts";
import { CatalogStore } from "./catalog-store.ts";
import { createAntigravityCommandHandler, type RuntimeBundleView, type ToolAuditSummary } from "./commands.ts";
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
  ensureAntigravityAcpReady,
  loadConfig,
  planToolProjection,
} from "./runtime.mjs";

export { keychain, logoutFollow };

interface OmpHostApi {
  on: (name: string, handler: (event: unknown, ctx: OmpCommandContext) => unknown) => void;
  registerProvider: (name: string, config: unknown) => void;
  unregisterProvider?: (name: string) => void;
  registerTool: (tool: unknown) => void;
  registerCommand: (name: string, command: { description: string; handler: (args: string, ctx: OmpCommandContext) => Promise<void> }) => void;
}

export function resolveAdapterStateDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  // OMP sets this to the active named profile's agent directory during CLI
  // bootstrap; it also honors an explicit default-profile override.
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configured ? configured === "~" ? home : configured.startsWith("~/") ? path.join(home, configured.slice(2)) : path.resolve(configured)
    : path.join(home, env.PI_CONFIG_DIR || ".omp", "agent");
  return path.join(agentDir, "antigravity-acp-provider");
}

export default async function (pi: OmpHostApi) {
  return registerOmpAdapter(pi, resolveAdapterStateDir());
}

// Explicit state injection keeps command integration tests away from user data.
export async function registerOmpAdapter(pi: OmpHostApi, stateDir: string) {
  const configPath = path.join(stateDir, "config.json");
  const cachePath = path.join(stateDir, "models-cache.json");
  const toolPolicyPath = path.join(stateDir, "omp-tools.json");
  const contextPath = path.join(stateDir, "context.json");
  let contextSettings = loadContextSettings(contextPath);
  let toolPolicy = loadToolPolicy(toolPolicyPath);
  let permissionMode = loadConfig(configPath).permissions;
  const sessionStorePath = path.join(stateDir, "sessions.json");
  const sessionStore = new AcpSessionStore(sessionStorePath);
  const cleanup = new SessionCleanup(stateDir);
  const diagnostics = new Diagnostics(path.join(stateDir, "diagnostics.json"));
  // Count saved records from disk so /antigravity-acp account needs no runtime.
  const savedSessionCount = (): number => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(sessionStorePath, "utf8"));
      return Array.isArray(parsed)
        ? parsed.filter(record => Boolean(record) && typeof record === "object" &&
            typeof (record as { piSessionId?: unknown }).piSessionId === "string").length
        : 0;
    } catch { return 0; }
  };

  // Loading this global extension must not start ACP or query Google.
  let readiness: Promise<void> | undefined;
  function prepareRuntime() {
    readiness ??= ensureAntigravityAcpReady().catch((error: unknown) => {
      readiness = undefined;
      throw error;
    });
    return readiness;
  }

  const connections = new Set<TierConnection>();
  const idleTimeoutMs = Number(process.env.OMP_ACP_IDLE_TIMEOUT_MS ?? 300_000);
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 0 || (idleTimeoutMs > 0 && idleTimeoutMs < 1000)) {
    throw new Error("OMP_ACP_IDLE_TIMEOUT_MS must be 0 (disabled) or an integer of at least 1000");
  }
  const maxIdleEntries = Number(process.env.OMP_ACP_MAX_IDLE_RUNTIMES ?? 2);
  if (!Number.isSafeInteger(maxIdleEntries) || maxIdleEntries < 0) throw new Error("OMP_ACP_MAX_IDLE_RUNTIMES must be a nonnegative integer (0 disables the cap)");
  const toolProjectionMemo = createStructuredFingerprintMemo();
  let toolRevision = 0;

  let lastToolAudit: ToolAuditSummary | undefined;
  let cachedToolProjection: {
    revision: string;
    tools: { name: string }[];
    availableNames: string;
    audit: ToolAuditSummary;
  } | undefined;

  const runtimes = new SessionRuntimePool<RuntimeBundleView>(() => {
    const ownedConnections = new Set<TierConnection>();
    const runtime = new AntigravityRuntime((options: ConstructorParameters<typeof TierConnection>[0]) => {
      const connection = new TierConnection({
        ...options,
        ompNativeTools: toolPolicy.nativeTools,
        ompDebugToolUpdates: toolPolicy.debugToolUpdates,
        ompUsageMode: contextSettings.defaults.usageMode ?? "auto",
        ompCleanup: cleanup,
        ompDiagnostics: diagnostics,
      });
      connections.add(connection);
      ownedConnections.add(connection);
      void connection.process.exited.finally(() => {
        connections.delete(connection);
        ownedConnections.delete(connection);
      });
      return connection;
    }, permissionMode, sessionStore);
    instrumentRuntime(runtime, diagnostics);
    return {
      runtime,
      provider: createAntigravityProvider(runtime).provider,
      isBusy: () => [...ownedConnections].some(connection => connection.activePrompts > 0),
    };
  }, bundle => bundle.runtime.close(), { timeoutMs: idleTimeoutMs, maxIdleEntries, canDispose: bundle => !bundle.isBusy() });

  const sessionIdOf = (ctx: OmpCommandContext | undefined): string | undefined => ctx?.sessionManager?.getSessionId?.();
  pi.on("session_shutdown", async (_event: unknown, ctx: OmpCommandContext) => {
    const sessionId = sessionIdOf(ctx);
    if (sessionId) {
      await Promise.all([runtimes.close(sessionId), runtimes.close()]);
    } else {
      await runtimes.closeAll();
    }
    await sessionStore.flush();
    if (!runtimes.values().length) await cleanup.stop();
  });

  function syncProviderRegistration() {
    // Re-registering without an apiKey does not clear OMP's stored key
    // config; unregister first so a logout report finds no remaining
    // "provider config (fallback)" source.
    try { pi.unregisterProvider?.("antigravity-acp"); } catch { /* older hosts */ }
    try { adapted.registerProvider(); } catch { /* advisory */ }
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
    closeAllRuntimes: () => runtimes.closeAll(),
    onSyncProvider: syncProviderRegistration,
  });

  const trackOmpSource = async (_event: unknown, ctx: OmpCommandContext) => {
    const id = ctx.sessionManager?.getSessionId?.(), file = ctx.sessionManager?.getSessionFile?.();
    if (id && file) try { await cleanup.trackSource(id, file); } catch { /* Unproven or not-yet-persisted sources remain protected. */ }
  };
  pi.on("session_start", async (event: unknown, ctx: OmpCommandContext) => {
    auth.watchOmpCredentials(ctx); await trackOmpSource(event, ctx); cleanup.start();
  });
  pi.on("agent_end", trackOmpSource);
  pi.on("session_switch", trackOmpSource);

  pi.registerTool({
    name: PERMISSION_TOOL_NAME,
    label: "Antigravity ACP Permission",
    description: "Answer a pending Antigravity permission request.",
    parameters: Type.Object({ requestId: Type.String({ minLength: 1 }) }),
    async execute(_id: string, params: { requestId: string }, _signal: unknown, _update: unknown, ctx: OmpCommandContext) {
      const request = runtimes.values().map(bundle => bundle.runtime.getPermission(params.requestId)).find(Boolean);
      if (!request) throw new Error("Permission request expired or missing");
      const labels = request.options.map((option: { label: string }) => option.label);
      const selected = await ctx.ui.select!(request.title, labels);
      const optionId = request.options[labels.indexOf(selected)]?.id;
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
    () => [...(FALLBACK_MODELS as PublicCatalogModel[])],
  );
  let initialModels = catalogStore.loadInitialOrCached(contextSettings);

  pi.registerCommand("antigravity-acp", {
    description: "Inspect ACP status/account/tools/usage/context/cleanup, manage Antigravity login/logout, configure budgets, toggle debug, refresh models or set tool policies",
    handler: createAntigravityCommandHandler({
      configPath,
      contextPath,
      toolPolicyPath,
      cleanup,
      diagnostics,
      connections,
      auth,
      catalog: catalogStore,
      prepareRuntime,
      getContextSettings: () => contextSettings,
      setContextSettings: next => { contextSettings = next; },
      getToolPolicy: () => toolPolicy,
      setToolPolicy: next => { toolPolicy = next; },
      setPermissionModeState: mode => { permissionMode = mode; },
      getLastToolAudit: () => lastToolAudit,
      getRuntimeForSession: sessionId => runtimes.get(sessionId),
      peekRuntimeForSession: sessionId => runtimes.peek(sessionId),
      getSavedSessionCount: savedSessionCount,
      getPermissionMode: () => permissionMode,
      getAllRuntimes: () => runtimes.values(),
      closeAllRuntimes: () => runtimes.closeAll(),
      onModelsUpdated: models => {
        initialModels = models;
        adapted.registerProvider();
      },
    }),
  });

  const adapted = new Proxy(pi, {
    get(target, key) {
      if (key !== "registerProvider") {
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return () => target.registerProvider("antigravity-acp", {
        api: "antigravity-acp",
        baseUrl: "acp://antigravity",
        // A config apiKey keeps OMP's own logout report claiming a remaining
        // "provider config (fallback)" source, but dropping it entirely hides
        // the catalog before the first /login. Register it only while an OMP
        // marker is known to exist or before any logout was observed.
        apiKey: auth.apiKeyFallback ? MARKER : undefined,
        models: initialModels,
        async fetchDynamicModels() {
          // OMP may call this during startup, even for another provider.
          // Network discovery is reserved for explicit refresh or first ACP use.
          return catalogStore.getDynamicModels(contextSettings);
        },
        streamSimple(
          model: { id: string },
          context: { tools?: Array<{ name: string }>; systemPrompt?: string; messages: unknown[] },
          options?: { sessionId?: string; reasoning?: string; signal?: AbortSignal },
        ) {
          const inputTools = context.tools ?? [];
          let tools: Array<{ name: string }>;
          let availableNames: string;
          const cached = cachedToolProjection;
          const revision = toolProjectionMemo(inputTools, () => String(++toolRevision));
          // Validate live definitions, including mutation of the same array.
          if (cached && cached.revision === revision) {
            tools = cached.tools;
            availableNames = cached.availableNames;
            lastToolAudit = cached.audit;
          } else {
            tools = stableTools(inputTools);
            const bridged = tools.filter(tool => tool.name !== PERMISSION_TOOL_NAME);
            const omitted: Array<{ name: string; reason: string }> = planToolProjection(tools);
            const omittedNames = new Set(omitted.map(tool => tool.name));
            const available = bridged.filter(tool => !omittedNames.has(tool.name));
            availableNames = available.length
              ? available.map(tool => `pi_${tool.name}`).join(", ")
              : "none currently available; report missing capabilities before proposing native operations";
            lastToolAudit = {
              offered: bridged.map(tool => tool.name),
              available: available.map(tool => tool.name),
              omitted,
            };
            cachedToolProjection = { revision, tools, availableNames, audit: lastToolAudit };
          }
          const routedContext = {
            ...context,
            tools,
            systemPrompt: `${context.systemPrompt ?? ""}\n\n${TOOL_ROUTING}\nOMP tool names: ${availableNames}`,
          };
          if (process.env.OMP_ACP_TRACE === "1") {
            console.error("[ACP tools]", JSON.stringify(lastToolAudit));
          }
          // OMP needs a stream synchronously. Defer runtime setup behind it so
          // loading/selecting/listing models performs no ACP process activity.
          const deferred = new PiEventWriter(model);
          void (async () => {
            try {
              if (options?.signal?.aborted) throw new Error("ACP request cancelled before startup");
              await diagnostics.measure("runtime.prepare", prepareRuntime);
              if (options?.signal?.aborted) throw new Error("ACP request cancelled during startup");
              if (!catalogStore.upstreamModels.has(model.id)) await catalogStore.refresh(contextSettings);
              const original = catalogStore.upstreamModels.get(model.id);
              if (!original) throw new Error(`Antigravity model was not discovered: ${model.id}. Run /antigravity-acp refresh.`);
              const lease = runtimes.acquire(options?.sessionId);
              const { runtime, provider } = lease.value;
              try {
                const stream = provider.streamSimple(selectRuntimeModel(original, options?.reasoning), routedContext, options);
                for await (const event of stream) {
                  const message = event.message ?? event.partial;
                  if (message?.usage) applyApiCostEstimate(model.id, message.usage, message.timestamp ?? Date.now());
                  deferred.stream.push(event);
                }
                deferred.stream.end();
                if (process.env.OMP_ACP_TRACE === "1") {
                  const snapshot = await runtime.snapshot();
                  console.error("[ACP bridge]", JSON.stringify(snapshot.processes.map((item: { mcpHttp: boolean; omittedTools: unknown[] }) => ({ mcpHttp: item.mcpHttp, omittedTools: item.omittedTools }))));
                }
              } finally { lease.release(); }
            } catch (error) {
              deferred.fail(error, options?.signal?.aborted === true);
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
            await auth.beginFreshGoogleLogin();
            const result = await runtimes.get().provider.auth.oauth.login({
              signal: callbacks.signal,
              notify(event: { message?: string; links?: Array<{ url: string }> }) {
                if (event.links?.length) {
                  for (const link of event.links) callbacks.onAuth({ url: link.url, instructions: event.message });
                } else callbacks.onProgress?.(event.message);
              },
              prompt: (request: { message: string; placeholder?: string }) => callbacks.onPrompt({ message: request.message, placeholder: request.placeholder }),
            });
            // Record the signed-in account on the marker credential so OMP's
            // account list can label it; the email is identity data, not a secret.
            const email = antigravityAccountEmail();
            return email ? { ...result, email } : result;
          },
          refreshToken: (credentials: unknown) => runtimes.get().provider.auth.oauth.refresh(credentials),
          getApiKey: () => MARKER,
        },
      });
    },
  });
  adapted.registerProvider();
}
