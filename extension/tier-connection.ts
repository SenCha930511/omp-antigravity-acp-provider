// Compatibility seam for vendored pi-antigravity-acp-provider 0.1.15 / ACP server 1.4.x.
// OMP effort -> vendored advertised legacy ID -> official model/thought selectors.
import { AntigravityAcpConnection } from "./vendor/pi-antigravity-acp-provider/src/acp/connection.ts";
import { choices, resolveSelection, selector } from "./selectors.ts";
import { installSessionRouting, type NativeToolMode } from "./tool-routing.ts";
import { showAcpUpdate } from "./activity-presentation.ts";
import { parseSessionUsage, usageDelta, type SessionUsage } from "./usage-accounting.ts";
import type { SessionCleanup } from "./session-cleanup.ts";
import type { Diagnostics } from "./diagnostics.ts";

export class TierConnection extends AntigravityAcpConnection {
  confirmedThinking: { model: string; effort: string } | undefined;
  debugToolUpdates: boolean;
  activePrompts = 0;
  usageQueryCount = 0;
  usageQueryMs = 0;
  usageMode: "auto" | "off" = "auto";
  readonly contextUsage = new Map<string, { used: number; size: number }>();
  readonly usageStatus = new Map<string, { source: string; cache: string; error?: string }>();
  private readonly usageBaselines = new Map<string, SessionUsage>();
  private readonly usageCaptures = new Map<string, { text: string }>();
  private readonly usageCommands = new Set<string>();
  private cleanup?: SessionCleanup;
  private diagnostics?: Diagnostics;
  private readonly firstOutput = new Map<string, number>();
  private readonly pendingOwned = new Set<string>();
  private ownershipRetry?: Promise<void>;
  private cleanupLeases = new Map<string, string>();
  toolRouting: { nativeTools: NativeToolMode; channel: "pending" | "system-append" | "legacy-prompt" } | undefined;

  constructor(options: ConstructorParameters<typeof AntigravityAcpConnection>[0] & { ompNativeTools?: NativeToolMode; ompDebugToolUpdates?: boolean; ompUsageMode?: "auto" | "off"; ompCleanup?: SessionCleanup; ompDiagnostics?: Diagnostics }) {
    super(options);
    this.cleanup = options.ompCleanup;
    this.diagnostics = options.ompDiagnostics;
    this.cleanup?.start();
    void this.process.exited.then(() => this.releaseCleanupLeases()).catch(() => {});
    this.debugToolUpdates = options.ompDebugToolUpdates ?? false;
    this.usageMode = options.ompUsageMode ?? "auto";
    this.setHandlers({ ...options.handlers, onUpdate: async notification => {
      const update = notification.update as {
        sessionUpdate?: string;
        availableCommands?: Array<{ name?: string }>;
        used?: number;
        size?: number;
        content?: { type?: string; text?: string };
      };
      if (update.sessionUpdate === "available_commands_update") {
        if (update.availableCommands?.some(command => command.name === "usage")) this.usageCommands.add(notification.sessionId);
        else this.usageCommands.delete(notification.sessionId);
      }
      if (update.sessionUpdate === "usage_update" && typeof update.used === "number" && Number.isSafeInteger(update.used) && typeof update.size === "number" && Number.isSafeInteger(update.size)) {
        this.contextUsage.set(notification.sessionId, { used: update.used, size: update.size });
      }
      const capture = this.usageCaptures.get(notification.sessionId);
      if (capture) {
        if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") {
          capture.text += update.content.text;
        }
        return;
      }
      if (update.sessionUpdate === "agent_message_chunk" && this.firstOutput.has(notification.sessionId)) {
        this.diagnostics?.record("acp.first-output", performance.now() - this.firstOutput.get(notification.sessionId)!);
        this.firstOutput.delete(notification.sessionId);
      }
      if (showAcpUpdate(notification, this.debugToolUpdates)) await options.handlers?.onUpdate?.(notification);
    } });
    if (options.ompNativeTools) {
      this.toolRouting = { nativeTools: options.ompNativeTools, channel: "pending" };
      installSessionRouting((this as unknown as { connection: unknown }).connection, this.initialized, options.ompNativeTools, advanced => {
        this.toolRouting!.channel = advanced ? "system-append" : "legacy-prompt";
      });
    }
  }

  configureUsage(mode: "auto" | "off") {
    this.usageMode = mode;
    this.usageBaselines.clear();
  }

  override async newSession(...args: Parameters<AntigravityAcpConnection["newSession"]>) {
    const session = await super.newSession(...args);
    if (this.cleanup) {
      try { this.cleanupLeases.set(session.sessionId, await this.cleanup.acquire(session.sessionId, true, this.process.pid!)); }
      catch { this.pendingOwned.add(session.sessionId); console.warn("[ACP cleanup] Registration deferred; preserving session files and retrying."); }
    }
    this.usageBaselines.set(session.sessionId, { input: 0, completion: 0, thinking: 0, cached: 0, total: 0 });
    return session;
  }

  private async protectSession(id: string) {
    if (this.cleanup && !this.cleanupLeases.has(id)) {
      // Lease before the resume/load RPC, including while the server replays.
      this.cleanupLeases.set(id, await this.cleanup.acquire(id, false, this.process.pid!, 5000));
    }
  }
  override async resumeSession(...args: Parameters<AntigravityAcpConnection["resumeSession"]>) {
    await this.protectSession(args[0]);
    return super.resumeSession(...args);
  }
  override async loadSession(...args: Parameters<AntigravityAcpConnection["loadSession"]>) {
    await this.protectSession(args[0]);
    return super.loadSession(...args);
  }
  private dropSessionState(id: string) {
    this.contextUsage?.delete(id);
    this.usageStatus?.delete(id);
    this.usageBaselines?.delete(id);
    this.usageCommands?.delete(id);
  }
  async retireForReplacement(key: string, id: string) {
    const unloaded = !Object.keys(this.getSessionState(id)).length;
    if (!this.activePrompts) this.dropSessionState(id);
    if (unloaded) {
      const token = this.cleanupLeases?.get(id);
      if (token) {
        try { await this.cleanup?.release(token, true); this.cleanupLeases.delete(id); } catch { /* Retry on close. */ }
      }
    }
    try { await this.cleanup?.retire(key, id); } catch { /* Retried by the cleanup ledger. */ }
  }
  async confirmReplacement(key: string, id: string) {
    try { await this.cleanup?.confirm(key, id, true); } catch { /* Retry cleanup on a later successful turn. */ }
  }
  async discardSession(id: string) {
    // Explicitly disposable discovery sessions need no model replacement.
    await this.retireForReplacement(`discovery:${id}`, id);
    await this.confirmReplacement(`discovery:${id}`, "discovery-complete");
  }
  private async releaseCleanupLeases() {
    if (this.process.alive) return;
    await this.retryOwnership();
    for (const [id, token] of this.cleanupLeases ?? []) {
      try { await this.cleanup?.release(token, true); this.cleanupLeases.delete(id); } catch { /* Live PID leases fail closed. */ }
    }
  }
  override async close() {
    await super.close();
    await this.releaseCleanupLeases();
    this.contextUsage?.clear();
    this.usageStatus?.clear();
    this.usageBaselines?.clear();
    this.usageCommands?.clear();
    this.usageCaptures?.clear();
    this.firstOutput?.clear();
  }
  private async retryOwnership() {
    if (this.ownershipRetry) return this.ownershipRetry;
    const pending = this.retryOwnershipOnce(); this.ownershipRetry = pending;
    try { await pending; } finally { if (this.ownershipRetry === pending) this.ownershipRetry = undefined; }
  }
  private async retryOwnershipOnce() {
    for (const id of this.pendingOwned ?? []) {
      try { this.cleanupLeases.set(id, await this.cleanup!.acquire(id, true, this.process.pid!)); this.pendingOwned.delete(id); }
      catch { /* Unknown data stays protected if durable registration is unavailable. */ }
    }
  }

  private async readUsage(sessionId: string, signal?: AbortSignal) {
    const started = performance.now();
    this.usageQueryCount++;
    const capture = { text: "" };
    this.usageCaptures.set(sessionId, capture);
    try {
      const deadline = AbortSignal.timeout(5_000);
      await super.prompt({ sessionId, prompt: [{ type: "text", text: "/usage" }] },
        signal ? AbortSignal.any([signal, deadline]) : deadline);
      return parseSessionUsage(capture.text);
    } finally {
      if (this.usageCaptures.get(sessionId) === capture) this.usageCaptures.delete(sessionId);
      this.usageQueryMs += performance.now() - started;
    }
  }

  override async prompt(request: Parameters<AntigravityAcpConnection["prompt"]>[0], signal?: AbortSignal) {
    this.activePrompts++;
    const id = request.sessionId;
    await this.retryOwnership();
    let abortedAt: number | undefined;
    const aborted = () => { abortedAt = performance.now(); };
    signal?.addEventListener("abort", aborted, { once: true });
    try { await this.cleanup?.touch(id); } catch { /* Cleanup must not affect inference. */ }
    try {
      const queryUsage = process.env.OMP_ACP_USAGE !== "off" && this.usageMode !== "off" && this.usageCommands.has(id);
      if (queryUsage && !this.usageBaselines.has(id)) {
        try {
          const baseline = await this.readUsage(id, signal);
          if (baseline) this.usageBaselines.set(id, baseline);
        } catch { /* Restore baseline is optional; never count the prior session as this turn. */ }
      }
      const started = performance.now();
      this.firstOutput?.set(id, started);
      const response = await super.prompt(request, signal);
      this.diagnostics?.record("acp.prompt", performance.now() - started);
      if (abortedAt !== undefined && ["cancelled", "end_turn"].includes(response.stopReason)) this.diagnostics?.record("acp.cancel-confirmation", performance.now() - abortedAt);
      const withContext = <T extends { _meta?: Record<string, unknown> }>(value: T): T => {
        const context = this.contextUsage.get(id);
        return context ? { ...value, _meta: { ...value._meta, ompContextTokens: context.used } } : value;
      };
      if (response.usage || response.stopReason === "cancelled" || process.env.OMP_ACP_USAGE === "off" || this.usageMode === "off" || !this.usageCommands.has(id) || signal?.aborted) {
        this.usageBaselines.delete(id);
        this.usageStatus.set(id, { source: response.usage ? "ACP response" : "unavailable", cache: "unknown" });
        return withContext(response);
      }
      try {
        const after = await this.readUsage(id, signal);
        const before = this.usageBaselines.get(id);
        const usage = before && after ? usageDelta(before, after) : undefined;
        if (after) this.usageBaselines.set(id, after); else this.usageBaselines.delete(id);
        this.usageStatus.set(id, { source: usage ? "official /usage delta (main agent)" : "unavailable", cache: usage?.cachedReadTokens === undefined ? "unknown" : "reported" });
        return withContext(usage ? { ...response, usage } : response);
      } catch {
        this.usageBaselines.delete(id);
        this.usageStatus.set(id, { source: "unavailable", cache: "unknown", error: "Official usage query failed or timed out" });
        return withContext(response);
      }
    } finally {
      signal?.removeEventListener("abort", aborted);
      this.firstOutput?.delete(id);
      this.activePrompts--;
      try { await this.cleanup?.touch(id); } catch { /* Keep accounting optional. */ }
    }
  }

  override async setModel(sessionId: string, modelId: string, signal?: AbortSignal): Promise<void> {
    const { modelId: base, effort } = resolveSelection(this.getSessionState(sessionId), modelId);
    // These are official ACP session/set_config_option requests. The legacy
    // model ID is never submitted as a made-up value to the modern selector.
    await super.setModel(sessionId, base, signal);
    this.confirmedThinking = undefined;
    if (!effort) return;
    const thoughtSelector = selector(this.getSessionState(sessionId), "thought_level");
    if (!thoughtSelector || !choices(thoughtSelector).some(option => option.value === effort)) {
      throw new Error(`ACP does not advertise thinking level ${effort} for ${base}`);
    }
    // Upstream 0.1.15 already has a deadline/abort-aware, verified selector
    // helper. Its TypeScript signature only mentions model/mode; thought_level
    // uses the exact same stable ACP RPC and server-advertised category.
    const selected = await (this as unknown as { setSelector: (sessionId: string, selectorId: string, value: string, signal?: AbortSignal) => Promise<boolean> }).setSelector(sessionId, thoughtSelector.id, effort, signal);
    if (!selected) throw new Error("Antigravity did not advertise a thinking-level selector");
    const state = this.getSessionState(sessionId);
    const model = selector(state, "model");
    const thought = selector(state, "thought_level");
    if (model?.currentValue !== base || thought?.currentValue !== effort) {
      throw new Error("Antigravity did not confirm the requested model and thinking level");
    }
    this.confirmedThinking = { model: base, effort };
    if (process.env.OMP_ACP_TRACE === "1") {
      console.error(`[ACP confirmed] model=${base} thinking=${effort}`);
    }
  }
}
