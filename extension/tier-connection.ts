// Compatibility seam for vendored pi-antigravity-acp-provider 0.1.15 / ACP server 1.4.x.
// OMP effort -> vendored advertised legacy ID -> official model/thought selectors.
import { AntigravityAcpConnection } from "./vendor/pi-antigravity-acp-provider/src/acp/connection.ts";
import { choices, resolveSelection, selector } from "./selectors.ts";
import { installSessionRouting, type NativeToolMode } from "./tool-routing.ts";
import { showAcpUpdate } from "./activity-presentation.ts";
import { alignContextTokens, applyCompactionChunk, applyCompactionUpdate, isTerminalCompaction, type AcpCompactionNotice, type AcpCompactionRecord } from "./acp-compaction.ts";
import { AgentNoticeFilter } from "./agent-notices.ts";
import { parseSessionUsage, usageDelta, type SessionUsage } from "./usage-accounting.ts";
import { DEFAULT_USAGE_MODE } from "./context-settings.ts";
import type { SessionCleanup } from "./session-cleanup.ts";
import type { Diagnostics } from "./diagnostics.ts";
import { deferredAbortSignal, isSteerAbort, steerMode as resolveSteerMode, steerTimings as resolveSteerTimings, type SteerMode, type SteerTimings } from "./turn-cancellation.ts";
import { PermissionIdentityRegistry } from "./permission-identity.ts";

const CONTINUATION_PROMPT = "Continue exactly where your previous output stopped. Do not repeat any earlier text.";
function continuationLimit(): number {
  const raw = process.env.OMP_ACP_MAX_CONTINUATIONS;
  if (raw === undefined || raw.trim() === "") return 3;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 10) throw new Error("OMP_ACP_MAX_CONTINUATIONS must be an integer between 0 and 10");
  return value;
}

// Updates that would extend the retained turn output stay frozen while a
// turn the server cannot cancel drains towards its natural end.
const STEER_FROZEN_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);
type UpdateHandler = NonNullable<NonNullable<ConstructorParameters<typeof AntigravityAcpConnection>[0]["handlers"]>["onUpdate"]>;
export class TierConnection extends AntigravityAcpConnection {
  confirmedThinking: { model: string; effort: string } | undefined;
  debugToolUpdates: boolean;
  activePrompts = 0;
  usageQueryCount = 0;
  usageQueryMs = 0;
  usageMode: "auto" | "off" = "auto";
  readonly contextUsage = new Map<string, { used: number; size: number }>();
  readonly compactions = new Map<string, Map<string, AcpCompactionRecord>>();
  readonly usageStatus = new Map<string, { source: string; cache: string; error?: string }>();
  private readonly ompContextWindows = new Map<string, number>();
  private readonly usageBaselines = new Map<string, SessionUsage>();
  private readonly usageCaptures = new Map<string, { text: string }>();
  private readonly usageReads = new Map<string, Promise<SessionUsage | undefined>>();
  private readonly usageCommands = new Set<string>();
  private cleanup?: SessionCleanup;
  private diagnostics?: Diagnostics;
  private readonly firstOutput = new Map<string, number>();
  private readonly noticeFilter = new AgentNoticeFilter();
  private readonly pendingOwned = new Set<string>();
  private ownershipRetry?: Promise<void>;
  private cleanupLeases = new Map<string, string>();
  toolRouting: { nativeTools: NativeToolMode; channel: "pending" | "system-append" | "legacy-prompt" } | undefined;
  private readonly steerMode: SteerMode;
  private readonly steerTimings: SteerTimings;
  private readonly maxContinuations: number;
  private readonly steerMuted = new Set<string>();
  private readonly steerActivity = new Map<string, Set<() => void>>();
  private readonly permissionIdentity = new PermissionIdentityRegistry();
  private readonly permissionTurns = new Map<string, number>();
  private readonly noticeHandler: UpdateHandler | undefined;
  private readonly noticeClosed = new Set<string>();

  constructor(options: ConstructorParameters<typeof AntigravityAcpConnection>[0] & { ompNativeTools?: NativeToolMode; ompDebugToolUpdates?: boolean; ompUsageMode?: "auto" | "off"; ompSteerMode?: SteerMode; ompSteerTimings?: SteerTimings; ompCleanup?: SessionCleanup; ompDiagnostics?: Diagnostics }) {
    super(options);
    this.cleanup = options.ompCleanup;
    this.diagnostics = options.ompDiagnostics;
    this.cleanup?.start();
    void this.process.exited.then(() => this.releaseCleanupLeases()).catch(() => {});
    this.debugToolUpdates = options.ompDebugToolUpdates ?? false;
    this.usageMode = options.ompUsageMode ?? DEFAULT_USAGE_MODE;
    this.steerMode = options.ompSteerMode ?? resolveSteerMode();
    this.steerTimings = options.ompSteerTimings ?? resolveSteerTimings();
    this.maxContinuations = continuationLimit();
    this.noticeHandler = options.handlers?.onUpdate;
    const permissionHandler = options.handlers?.onPermission;
    this.setHandlers({ ...options.handlers, onPermission: async request => {
      await this.emitHeldNotice(request.sessionId);
      const decision = this.permissionIdentity?.check(request.sessionId, this.permissionTurn(request.sessionId), request);
      if (decision) return decision;
      return permissionHandler ? permissionHandler(request) : { outcome: { outcome: "cancelled" } };
    }, onUpdate: async notification => {
      const update = notification.update as {
        sessionUpdate?: string;
        availableCommands?: Array<{ name?: string }>;
        used?: number;
        size?: number;
        content?: { type?: string; text?: string };
        compactionId?: unknown;
        status?: unknown;
        summary?: unknown;
        error?: unknown;
      };
      this.permissionIdentity?.record(notification.sessionId, this.permissionTurn(notification.sessionId), update);
      if (this.noticeClosed?.has(notification.sessionId) && STEER_FROZEN_UPDATES.has(update.sessionUpdate ?? "")) return;
      if (update.sessionUpdate === "available_commands_update") {
        if (update.availableCommands?.some(command => command.name === "usage")) this.usageCommands.add(notification.sessionId);
        else this.usageCommands.delete(notification.sessionId);
      }
      if (update.sessionUpdate === "usage_update" && typeof update.used === "number" && Number.isSafeInteger(update.used) && typeof update.size === "number" && Number.isSafeInteger(update.size)) {
        this.contextUsage.set(notification.sessionId, { used: update.used, size: update.size });
      }
      if (update.sessionUpdate === "compaction_update" || update.sessionUpdate === "compaction_summary_chunk") {
        await this.emitHeldNotice(notification.sessionId);
        this.recordCompaction(notification.sessionId, update);
        // Keep the server-owned summary out of OMP's transcript, but let the
        // runtime mark a binding unsafe when a tool/permission is parked.
        if (showAcpUpdate(notification, this.debugToolUpdates)) await options.handlers?.onUpdate?.(notification);
        return;
      }
      const capture = this.usageCaptures.get(notification.sessionId);
      if (capture) {
        if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") {
          capture.text += update.content.text;
        }
        return;
      }
      let forward = notification;
      if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") {
        const text = this.noticeFilter.accept(notification.sessionId, update.content.text);
        if (text === undefined) return;
        this.markFirstOutput(notification.sessionId);
        if (text !== update.content.text) {
          forward = { ...notification, update: { ...update, content: { ...update.content, text } } } as typeof notification;
        }
      } else if (update.sessionUpdate !== "agent_message_chunk" ||
        update.content?.type !== "text" || typeof update.content.text !== "string") {
        await this.emitHeldNotice(notification.sessionId);
      }
      if (this.steerMuted.has(notification.sessionId)) {
        // The turn cannot be cancelled and is draining towards its natural
        // end: the update proves it is alive and extends the steering grace,
        // while output-mutating updates stay frozen so the checkpointed
        // fingerprint still matches what OMP retained at the boundary.
        for (const listener of [...this.steerActivity.get(notification.sessionId) ?? []]) listener();
        if (STEER_FROZEN_UPDATES.has(update.sessionUpdate ?? "")) return;
      }
      if (showAcpUpdate(forward, this.debugToolUpdates)) await options.handlers?.onUpdate?.(forward);
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

  setOmpContextWindow(sessionId: string, contextWindow: number): void {
    if (Number.isSafeInteger(contextWindow) && contextWindow > 0) this.ompContextWindows.set(sessionId, contextWindow);
  }

  getOmpContextWindow(sessionId: string): number | undefined {
    return this.ompContextWindows.get(sessionId);
  }

  recordCompaction(sessionId: string, update: {
    sessionUpdate?: string;
    compactionId?: unknown;
    status?: unknown;
    summary?: unknown;
    error?: unknown;
    content?: unknown;
  }): void {
    let records = this.compactions.get(sessionId);
    if (!records) this.compactions.set(sessionId, (records = new Map()));
    const id = typeof update.compactionId === "string" ? update.compactionId : undefined;
    if (!id) return;
    const current = records.get(id);
    const next = update.sessionUpdate === "compaction_summary_chunk"
      ? applyCompactionChunk(current, sessionId, { compactionId: id, content: update.content })
      : applyCompactionUpdate(current, sessionId, update);
    if (next) records.set(id, next);
  }

  takeCompactionNotices(): AcpCompactionNotice[] {
    const notices: AcpCompactionNotice[] = [];
    for (const [sessionId, records] of this.compactions) {
      for (const record of records.values()) {
        if (record.notified || !isTerminalCompaction(record.status)) continue;
        record.notified = true;
        notices.push({
          sessionId,
          compactionId: record.compactionId,
          status: record.status,
          summary: record.summary,
          ...(record.error !== undefined ? { error: record.error } : {}),
        });
      }
    }
    return notices;
  }


  // drainCancelledTurn calls this while waiting for a turn the server cannot
  // cancel, so retained partial output stays frozen at the steering boundary
  // and the checkpointed fingerprint still matches the OMP transcript.
  muteSteerChunks(sessionId: string) {
    this.steerMuted.add(sessionId);
  }

  // armSteerGiveup subscribes here: every update from the draining session
  // resets the silence window of the steering grace.
  onSteerActivity(sessionId: string, listener: () => void): () => void {
    let listeners = this.steerActivity.get(sessionId);
    if (!listeners) this.steerActivity.set(sessionId, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (!listeners!.size) this.steerActivity.delete(sessionId);
    };
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
    this.compactions?.delete(id);
    this.ompContextWindows?.delete(id);
    this.usageStatus?.delete(id);
    this.usageBaselines?.delete(id);
    this.usageCommands?.delete(id);
    this.usageReads?.delete(id);
    this.noticeFilter?.forget(id);
    this.noticeClosed?.delete(id);
    this.permissionIdentity?.forget(id);
    this.permissionTurns?.delete(id);
    this.steerMuted?.delete(id);
    this.steerActivity?.delete(id);
  }
  private permissionTurn(sessionId: string): number {
    return this.permissionTurns?.get(sessionId) ?? 0;
  }
  private async emitHeldNotice(sessionId: string): Promise<void> {
    const held = this.noticeFilter?.flush(sessionId);
    if (held === undefined) return;
    this.markFirstOutput(sessionId);
    const synthetic = {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: held } },
    } as Parameters<NonNullable<typeof this.noticeHandler>>[0];
    await this.noticeHandler?.(synthetic);
  }
  async retireForReplacement(key: string, id: string) {
    await this.retryOwnership();
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
    this.compactions?.clear();
    this.ompContextWindows?.clear();
    this.usageStatus?.clear();
    this.usageBaselines?.clear();
    this.usageCommands?.clear();
    this.usageCaptures?.clear();
    this.firstOutput?.clear();
    this.noticeFilter?.clear();
    this.noticeClosed?.clear();
    this.usageReads?.clear();
    this.permissionIdentity?.clear();
    this.permissionTurns?.clear();
    this.steerMuted?.clear();
    this.steerActivity?.clear();
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

  private markFirstOutput(sessionId: string): void {
    const started = this.firstOutput.get(sessionId);
    if (started === undefined) return;
    this.diagnostics?.record("acp.first-output", performance.now() - started);
    this.firstOutput.delete(sessionId);
  }

  private readUsage(sessionId: string, signal?: AbortSignal): Promise<SessionUsage | undefined> {
    const inflight = this.usageReads.get(sessionId);
    if (inflight) return inflight;
    // This query is a delta baseline, not a display quota. A TTL cache would
    // make the post-turn delta undercount, so only concurrent reads coalesce.
    let tracked: Promise<SessionUsage | undefined>;
    tracked = this.readUsageOnce(sessionId, signal).finally(() => {
      if (this.usageReads.get(sessionId) === tracked) this.usageReads.delete(sessionId);
    });
    this.usageReads.set(sessionId, tracked);
    return tracked;
  }

  private async readUsageOnce(sessionId: string, signal?: AbortSignal): Promise<SessionUsage | undefined> {
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

  private async promptWithContinuations(request: Parameters<AntigravityAcpConnection["prompt"]>[0], signal?: AbortSignal) {
    let response = await super.prompt(request, signal);
    for (let count = 0; count < this.maxContinuations && !signal?.aborted; count++) {
      if (response.stopReason !== "max_tokens" && response.stopReason !== "max_turn_requests") break;
      if (this.noticeFilter.consumeOutputLimitNotice(request.sessionId)) break;
      const continued = await super.prompt({ sessionId: request.sessionId, prompt: [{ type: "text", text: CONTINUATION_PROMPT }] }, signal);
      response = continued.usage || !response.usage ? continued : { ...continued, usage: response.usage };
    }
    return response;
  }

  override async prompt(request: Parameters<AntigravityAcpConnection["prompt"]>[0], signal?: AbortSignal) {
    this.activePrompts++;
    const id = request.sessionId;
    this.noticeClosed?.delete(id);
    const permissionTurn = this.permissionTurn(id) + 1;
    this.permissionTurns?.set(id, permissionTurn);
    this.permissionIdentity?.beginTurn(id, permissionTurn);
    // The next dispatch owns this session's stream again; updates from a
    // drained turn must no longer be frozen once it starts.
    this.steerMuted?.delete(id);
    await this.retryOwnership();
    let abortedAt: number | undefined;
    const queueHold = () => this.steerMode === "queue" && signal !== undefined && isSteerAbort(signal);
    const aborted = () => {
      abortedAt = performance.now();
      // Queue mode keeps the ACP turn alive after OMP's steering abort. Freeze
      // output from this point so the checkpoint matches what OMP retained.
      if (queueHold()) this.muteSteerChunks(id);
    };
    signal?.addEventListener("abort", aborted, { once: true });
    // The server may acknowledge session/cancel but still send final updates.
    // A transport abort would close the whole connection 1.5s later. Hold it
    // while the draining turn is alive; queue mode holds until it completes.
    const deferred = signal ? deferredAbortSignal(signal, this.steerTimings, { source: this, sessionId: id }, queueHold) : undefined;
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
      const response = await this.promptWithContinuations(request, deferred?.signal ?? signal);
      this.diagnostics?.record("acp.prompt", performance.now() - started);
      if (abortedAt !== undefined && ["cancelled", "end_turn"].includes(response.stopReason)) this.diagnostics?.record("acp.cancel-confirmation", performance.now() - abortedAt);
      const withContext = <T extends { _meta?: Record<string, unknown> }>(value: T): T => {
        const context = this.contextUsage.get(id);
        if (!context) return value;
        const ompContextWindow = this.ompContextWindows?.get(id);
        return {
          ...value,
          _meta: {
            ...value._meta,
            ompContextTokens: alignContextTokens(context.used, context.size, ompContextWindow),
            ompAcpContext: { used: context.used, size: context.size, ...(ompContextWindow ? { ompContextWindow } : {}) },
          },
        };
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
      deferred?.dispose();
      signal?.removeEventListener("abort", aborted);
      this.firstOutput?.delete(id);
      this.noticeClosed?.add(id);
      await this.emitHeldNotice(id);
      this.noticeFilter?.forget(id);
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
