// OMP-facing seam over the owned ACP connection.
// OMP effort -> advertised legacy ID -> official model/thought selectors.
import { AntigravityAcpConnection, type AntigravityConnectionHandlers, type SessionMeta } from "./runtime/acp/connection.ts";
import { resolveAntigravityAcpDirectory } from "./runtime/acp/antigravity.ts";
import type { AcpNewSessionResponse, SessionState } from "./runtime/acp/session-state.ts";
import { choices, resolveSelection, selector } from "./selectors.ts";
import { normalizeInitializeResponse, sessionRoutingRequest, type NativeToolMode, type SessionRpcRequest, type SessionRoutingKind } from "./tool-routing.ts";
import { showAcpUpdate } from "./activity-presentation.ts";
import { alignContextTokens, applyCompactionChunk, applyCompactionUpdate, isTerminalCompaction, type AcpCompactionNotice, type AcpCompactionRecord } from "./acp-compaction.ts";
import { AgentNoticeFilter } from "./agent-notices.ts";
import { parseSessionUsage, usageDelta, type SessionUsage } from "./usage-accounting.ts";
import { conversationDbPath, peekMaxModelStepIdx, readModelStepsAfter, type StepUsageBatch } from "./usage-db.ts";
import { DEFAULT_USAGE_MODE } from "./context-settings.ts";
import type { SessionCleanup } from "./session-cleanup.ts";
import type { Diagnostics } from "./diagnostics.ts";
import { deferredAbortSignal, isSteerAbort, steerMode as resolveSteerMode, steerTimings as resolveSteerTimings, type SteerMode, type SteerTimings } from "./turn-cancellation.ts";
import { PermissionIdentityRegistry } from "./permission-identity.ts";
import type { AvailableCommand, InitializeResponse, McpServer, PromptResponse } from "@agentclientprotocol/sdk";

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

// The ACP server commits a completed model step to the session store while
// the prompt response is already on the wire, so the first read can race a
// short WAL flush. The retries are bounded and stay inline with the turn.
const USAGE_DB_RETRY_DELAYS_MS = [15, 35] as const;

export type UsageRetryScheduler = (delayMs: number, signal?: AbortSignal) => Promise<void>;

const defaultUsageRetry: UsageRetryScheduler = (delayMs, signal) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    resolve();
    return promise;
  }
  const settle = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", settle);
    resolve();
  };
  const timer = setTimeout(settle, delayMs);
  signal?.addEventListener("abort", settle, { once: true });
  return promise;
};

// ACP response usage counts cache reads inside `inputTokens` (the provider
// projection subtracts them again), while the session store keeps uncached
// input. Adding the cached read back keeps one prompt from being billed
// twice; output, thought, cache-write and total keep the native contract.
export function usageFromStepBatch(batch: StepUsageBatch): NonNullable<PromptResponse["usage"]> {
  return {
    inputTokens: batch.usage.inputTokens + batch.usage.cachedReadTokens,
    outputTokens: batch.usage.outputTokens,
    thoughtTokens: batch.usage.thoughtTokens,
    cachedReadTokens: batch.usage.cachedReadTokens,
    cachedWriteTokens: batch.usage.cachedWriteTokens,
    totalTokens: batch.usage.totalTokens,
  };
}

// ACP reports usage per prompt turn. An automatic continuation is another
// prompt, so its counters must be added instead of replacing the first part.
export function mergeContinuationResponse(first: PromptResponse, next: PromptResponse): PromptResponse {
  const a = first.usage, b = next.usage;
  if (!a) return next;
  if (!b) return { ...next, usage: a };
  const sum = (left: number | null | undefined, right: number | null | undefined) =>
    left === undefined || left === null ? right ?? undefined : (left ?? 0) + (right ?? 0);
  const thoughtTokens = sum(a.thoughtTokens, b.thoughtTokens);
  const cachedReadTokens = sum(a.cachedReadTokens, b.cachedReadTokens);
  const cachedWriteTokens = sum(a.cachedWriteTokens, b.cachedWriteTokens);
  return {
    ...next,
    usage: {
      inputTokens: a.inputTokens + b.inputTokens,
      outputTokens: a.outputTokens + b.outputTokens,
      totalTokens: a.totalTokens + b.totalTokens,
      ...(thoughtTokens !== undefined ? { thoughtTokens } : {}),
      ...(cachedReadTokens !== undefined ? { cachedReadTokens } : {}),
      ...(cachedWriteTokens !== undefined ? { cachedWriteTokens } : {}),
    },
  };
}

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
  // Session SQLite stores live under the ACP app-data directory; injected in
  // tests so accounting never probes a real user tree.
  private readonly acpDirectory: string;
  private readonly usageRetry: UsageRetryScheduler;
  private readonly ompContextWindows = new Map<string, number>();
  private readonly usageBaselines = new Map<string, SessionUsage>();
  private readonly usageCaptures = new Map<string, { text: string }>();
  private readonly usageReads = new Map<string, Promise<SessionUsage | undefined>>();
  private readonly usageCommands = new Set<string>();
  private readonly usageCommandWaiters = new Map<string, Set<(available: boolean) => void>>();
  private cleanup?: SessionCleanup;
  private diagnostics?: Diagnostics;
  private readonly firstOutput = new Map<string, number>();
  private readonly noticeFilter = new AgentNoticeFilter();
  private readonly pendingOwned = new Set<string>();
  private ownershipRetry?: Promise<void>;
  private cleanupLeases = new Map<string, string>();
  toolRouting: { nativeTools: NativeToolMode; channel: "pending" | "system-append" | "legacy-prompt" } | undefined;
  private ompSystemInstructions = "";
  private ompSessionKind: SessionRoutingKind = "main";
  private ompProjectedToolNames: readonly string[] = [];
  private readonly steerMode: SteerMode;
  private readonly steerTimings: SteerTimings;
  private readonly maxContinuations: number;
  private readonly steerMuted = new Set<string>();
  private readonly steerActivity = new Map<string, Set<() => void>>();
  private readonly permissionIdentity = new PermissionIdentityRegistry();
  private readonly permissionTurns = new Map<string, number>();
  private ompHandlers: AntigravityConnectionHandlers = {};
  private noticeHandler: UpdateHandler | undefined;
  private readonly noticeClosed = new Set<string>();

  constructor(options: ConstructorParameters<typeof AntigravityAcpConnection>[0] & { ompNativeTools?: NativeToolMode; ompDebugToolUpdates?: boolean; ompUsageMode?: "auto" | "off"; ompSteerMode?: SteerMode; ompSteerTimings?: SteerTimings; ompCleanup?: SessionCleanup; ompDiagnostics?: Diagnostics; ompPurpose?: "quota"; ompAcpDirectory?: string; ompUsageRetry?: UsageRetryScheduler }) {
    super(options);
    this.cleanup = options.ompCleanup;
    this.diagnostics = options.ompDiagnostics;
    this.acpDirectory = options.ompAcpDirectory ?? options.ompCleanup?.acpDir ?? resolveAntigravityAcpDirectory();
    this.usageRetry = options.ompUsageRetry ?? defaultUsageRetry;
    this.cleanup?.start();
    void this.process.exited.then(() => this.releaseCleanupLeases()).catch(() => {});
    const stopUsageWaiters = () => {
      for (const id of this.usageCommandWaiters.keys()) this.resolveUsageCommandWaiters(id, false);
    };
    void this.process.exited.then(stopUsageWaiters, stopUsageWaiters);
    this.debugToolUpdates = options.ompDebugToolUpdates ?? false;
    this.usageMode = options.ompUsageMode ?? DEFAULT_USAGE_MODE;
    this.steerMode = options.ompSteerMode ?? resolveSteerMode();
    this.steerTimings = options.ompSteerTimings ?? resolveSteerTimings();
    this.maxContinuations = continuationLimit();
    // OMP binds the update/permission handlers when its runtime creates the
    // binding. A standby connection is initialized before that binding exists,
    // so the same wrapper is installed here and rebound in place later.
    this.ompHandlers = options.handlers ?? {};
    this.installHandlers();
    if (options.ompNativeTools) {
      this.toolRouting = { nativeTools: options.ompNativeTools, channel: "pending" };
    }
  }

  // The runtime owns one ACP session per binding. A pre-initialized standby is
  // handed to a binding after it was warmed, so its OMP-facing handlers are
  // rebound without rebuilding the transport. Usage capture, notice filtering,
  // permission identity, compaction tracking and steering state all stay in
  // this single wrapper; only the OMP callbacks behind it change.
  rebindHandlers(handlers: AntigravityConnectionHandlers | undefined): void {
    this.ompHandlers = handlers ?? {};
    this.installHandlers();
  }

  private installHandlers(): void {
    const handlers = this.ompHandlers;
    this.noticeHandler = handlers.onUpdate;
    this.setHandlers({ ...handlers, onPermission: async request => {
      await this.emitHeldNotice(request.sessionId);
      const decision = this.permissionIdentity?.check(request.sessionId, this.permissionTurn(request.sessionId), request);
      if (decision) return decision;
      return handlers.onPermission ? handlers.onPermission(request) : { outcome: { outcome: "cancelled" } };
    }, onUpdate: async notification => {
      const update = notification.update as {
        sessionUpdate?: string;
        availableCommands?: AvailableCommand[];
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
      if (update.sessionUpdate === "available_commands_update" && update.availableCommands) {
        this.updateUsageCommands(notification.sessionId, update.availableCommands);
      }
      if (update.sessionUpdate === "usage_update" && typeof update.used === "number" && Number.isSafeInteger(update.used) && typeof update.size === "number" && Number.isSafeInteger(update.size)) {
        this.contextUsage.set(notification.sessionId, { used: update.used, size: update.size });
      }
      if (update.sessionUpdate === "compaction_update" || update.sessionUpdate === "compaction_summary_chunk") {
        await this.emitHeldNotice(notification.sessionId);
        this.recordCompaction(notification.sessionId, update);
        // Keep the server-owned summary out of OMP's transcript, but let the
        // runtime mark a binding unsafe when a tool/permission is parked.
        if (showAcpUpdate(notification, this.debugToolUpdates)) await handlers.onUpdate?.(notification);
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
      if (showAcpUpdate(forward, this.debugToolUpdates)) await handlers.onUpdate?.(forward);
    } });
  }

  // The complete OMP system instruction is only known once the turn context is
  // available, but it must reach session/new, session/load and session/resume.
  // The runtime sets it after initialize and before those RPCs.
  setOmpSystemInstructions(text: string): void {
    this.ompSystemInstructions = text;
  }

  // A shadow binding routes an ephemeral side turn; every ordinary caller keeps
  // the main session guidance.
  setOmpSessionKind(kind: SessionRoutingKind): void {
    this.ompSessionKind = kind;
  }

  setOmpProjectedToolNames(names: readonly string[]): void {
    this.ompProjectedToolNames = [...names];
  }

  override async initialize(signal?: AbortSignal): Promise<InitializeResponse> {
    return normalizeInitializeResponse(await super.initialize(signal));
  }

  configureUsage(mode: "auto" | "off") {
    this.usageMode = mode;
    this.usageBaselines.clear();
  }

  private updateUsageCommands(sessionId: string, commands: readonly AvailableCommand[]): void {
    const available = commands.some(command => command.name === "usage");
    if (available) this.usageCommands.add(sessionId);
    else this.usageCommands.delete(sessionId);
    this.resolveUsageCommandWaiters(sessionId, available);
  }

  async waitForUsageCommand(sessionId: string, timeoutMs = 5_000, signal?: AbortSignal): Promise<boolean> {
    if (this.usageCommands.has(sessionId)) return true;
    if (timeoutMs <= 0 || signal?.aborted) return false;
    const { promise, resolve } = Promise.withResolvers<boolean>();
    let waiters = this.usageCommandWaiters.get(sessionId);
    if (!waiters) {
      waiters = new Set();
      this.usageCommandWaiters.set(sessionId, waiters);
    }
    const settle = (available: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      waiters.delete(settle);
      if (!waiters.size && this.usageCommandWaiters.get(sessionId) === waiters) this.usageCommandWaiters.delete(sessionId);
      resolve(available);
    };
    waiters.add(settle);
    const onAbort = () => settle(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => settle(false), timeoutMs);
    return promise;
  }

  private resolveUsageCommandWaiters(sessionId: string, available: boolean): void {
    const waiters = this.usageCommandWaiters?.get(sessionId);
    this.usageCommandWaiters?.delete(sessionId);
    if (waiters) for (const settle of waiters) settle(available);
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

  takeCompactionNotices(acpSessionId?: string): AcpCompactionNotice[] {
    const notices: AcpCompactionNotice[] = [];
    for (const [sessionId, records] of this.compactions) {
      if (acpSessionId !== undefined && sessionId !== acpSessionId) continue;
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

  // Session routing is computed per call from the same pure builder the tests
  // exercise, then handed to the base method as the official `_meta` argument.
  protected async sessionMeta(request: SessionRpcRequest): Promise<SessionMeta | undefined> {
    const routing = this.toolRouting;
    if (!routing) return request._meta;
    const routed = sessionRoutingRequest(request, await this.initialize(), routing.nativeTools,
      this.ompSystemInstructions, this.ompSessionKind, this.ompProjectedToolNames.length > 0, this.ompProjectedToolNames);
    routing.channel = routed === request ? "legacy-prompt" : "system-append";
    return routed._meta;
  }

  override async newSession(
    cwd: string,
    signal?: AbortSignal,
    mcpServers: McpServer[] = [],
    meta?: SessionMeta,
  ): Promise<AcpNewSessionResponse> {
    const routed = await this.sessionMeta({ cwd, mcpServers, ...(meta === undefined ? {} : { _meta: meta }) });
    const session = await super.newSession(cwd, signal, mcpServers, routed);
    if (this.cleanup) {
      try { this.cleanupLeases.set(session.sessionId, await this.cleanup.acquire(session.sessionId, true, this.process.pid!)); }
      catch { this.pendingOwned.add(session.sessionId); console.warn("[ACP cleanup] Registration deferred; preserving session files and retrying."); }
    }
    this.usageBaselines.set(session.sessionId, { input: 0, completion: 0, thinking: 0, cached: 0, total: 0 });
    if ("availableCommands" in session && Array.isArray(session.availableCommands)) {
      this.updateUsageCommands(session.sessionId, session.availableCommands);
    }
    return session;
  }

  private async protectSession(id: string) {
    if (this.cleanup && !this.cleanupLeases.has(id)) {
      // Lease before the resume/load RPC, including while the server replays.
      this.cleanupLeases.set(id, await this.cleanup.acquire(id, false, this.process.pid!, 5000));
    }
  }
  override async resumeSession(
    sessionId: string,
    cwd: string,
    mcpServers: McpServer[] = [],
    signal?: AbortSignal,
    meta?: SessionMeta,
  ): Promise<SessionState> {
    await this.protectSession(sessionId);
    const routed = await this.sessionMeta({ sessionId, cwd, mcpServers, ...(meta === undefined ? {} : { _meta: meta }) });
    const session = await super.resumeSession(sessionId, cwd, mcpServers, signal, routed);
    if ("availableCommands" in session && Array.isArray(session.availableCommands)) {
      this.updateUsageCommands(sessionId, session.availableCommands);
    }
    return session;
  }
  override async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: McpServer[] = [],
    signal?: AbortSignal,
    meta?: SessionMeta,
  ): Promise<SessionState> {
    await this.protectSession(sessionId);
    const routed = await this.sessionMeta({ sessionId, cwd, mcpServers, ...(meta === undefined ? {} : { _meta: meta }) });
    const session = await super.loadSession(sessionId, cwd, mcpServers, signal, routed);
    if ("availableCommands" in session && Array.isArray(session.availableCommands)) {
      this.updateUsageCommands(sessionId, session.availableCommands);
    }
    return session;
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
  private async emitHeldNotice(sessionId: string, force = false): Promise<void> {
    if (!force && this.noticeClosed?.has(sessionId)) return;
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
    for (const id of this.usageCommandWaiters?.keys() ?? []) this.resolveUsageCommandWaiters(id, false);
    await super.close();
    await this.releaseCleanupLeases();
    this.contextUsage?.clear();
    this.compactions?.clear();
    this.ompContextWindows?.clear();
    this.usageStatus?.clear();
    this.usageBaselines?.clear();
    this.usageCommands?.clear();
    this.usageCommandWaiters?.clear();
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

  async promptWithoutUsageDeltas(request: Parameters<AntigravityAcpConnection["prompt"]>[0], signal?: AbortSignal) {
    return super.prompt(request, signal);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = super.prompt({ sessionId, prompt: [{ type: "text", text: "/usage" }] }, signal);
      void pending.catch(() => undefined);
      const timedOut = new Promise<undefined>(resolve => {
        timer = setTimeout(() => {
          // /usage is an optional side query. Cancel its turn without passing
          // an abort signal into the shared prompt path, which would close the
          // whole warm connection after its grace period.
          void this.cancel(sessionId).catch(() => undefined);
          resolve(undefined);
        }, 5_000);
        timer.unref?.();
      });
      const response = await Promise.race([pending, timedOut]);
      return response === undefined ? undefined : parseSessionUsage(capture.text);
    } finally {
      if (timer) clearTimeout(timer);
      if (this.usageCaptures.get(sessionId) === capture) this.usageCaptures.delete(sessionId);
      this.usageQueryMs += performance.now() - started;
    }
  }

  // The store is only consulted when this turn sent no /usage query, so the
  // retries never buy a second prompt. Each attempt re-reads only the rows a
  // completed model step appended after the cursor taken before the prompt.
  private async readModelUsageBatch(
    dbPath: string | undefined,
    afterIdx: number,
    signal?: AbortSignal,
  ): Promise<StepUsageBatch | undefined> {
    if (!dbPath || signal?.aborted) return undefined;
    const immediate = readModelStepsAfter(dbPath, afterIdx);
    if (immediate) return immediate;
    const retry = this.usageRetry ?? defaultUsageRetry;
    for (const delayMs of USAGE_DB_RETRY_DELAYS_MS) {
      if (signal?.aborted) return undefined;
      await retry(delayMs, signal);
      if (signal?.aborted) return undefined;
      const retried = readModelStepsAfter(dbPath, afterIdx);
      if (retried) return retried;
    }
    return undefined;
  }

  private async promptWithContinuations(request: Parameters<AntigravityAcpConnection["prompt"]>[0], signal?: AbortSignal) {
    let response = await super.prompt(request, signal);
    for (let count = 0; count < this.maxContinuations && !signal?.aborted; count++) {
      if (response.stopReason !== "max_tokens" && response.stopReason !== "max_turn_requests") break;
      if (this.noticeFilter.consumeOutputLimitNotice(request.sessionId)) break;
      const continued = await super.prompt({ sessionId: request.sessionId, prompt: [{ type: "text", text: CONTINUATION_PROMPT }] }, signal);
      response = mergeContinuationResponse(response, continued);
    }
    return response;
  }

  override async prompt(request: Parameters<AntigravityAcpConnection["prompt"]>[0], signal?: AbortSignal): Promise<PromptResponse> {
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
      this.muteSteerChunks(id);
    };
    signal?.addEventListener("abort", aborted, { once: true });
    // The server may acknowledge session/cancel but still send final updates.
    // A transport abort would close the whole connection 1.5s later, so queue
    // steering holds it while the draining turn is alive. Explicit user or
    // internal cancellation skips the hold so the upstream prompt sends
    // session/cancel at once.
    const deferred = signal ? deferredAbortSignal(signal, this.steerTimings, { source: this, sessionId: id }, queueHold, () => !isSteerAbort(signal)) : undefined;
    try { await this.cleanup?.touch(id); } catch { /* Cleanup must not affect inference. */ }
    try {
      const envUsageEnabled = process.env.OMP_ACP_USAGE !== "off";
      const queryUsage = envUsageEnabled && this.usageMode !== "off" && this.usageCommands.has(id);
      if (queryUsage && !this.usageBaselines.has(id)) {
        try {
          const baseline = await this.readUsage(id, signal);
          if (baseline) this.usageBaselines.set(id, baseline);
        } catch { /* Restore baseline is optional; never count the prior session as this turn. */ }
      }
      // This session's last completed model step before the prompt bounds the
      // post-turn delta, so rows from earlier turns are never re-counted. The
      // store is only read when this turn sends no /usage query, and the read
      // stays inline with the turn instead of becoming detached work.
      const dbPath = envUsageEnabled && !queryUsage && this.acpDirectory
        ? conversationDbPath(this.acpDirectory, id) : undefined;
      const dbCursor = dbPath === undefined ? undefined : peekMaxModelStepIdx(dbPath);
      const started = performance.now();
      this.firstOutput?.set(id, started);
      const response = await this.promptWithContinuations(request, deferred?.signal ?? signal);
      this.diagnostics?.record("acp.prompt", performance.now() - started);
      if (abortedAt !== undefined && ["cancelled", "end_turn"].includes(response.stopReason)) this.diagnostics?.record("acp.cancel-confirmation", performance.now() - abortedAt);
      const withContext = (value: PromptResponse): PromptResponse => {
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
      if (response.usage || response.stopReason === "cancelled" || !envUsageEnabled || signal?.aborted) {
        this.usageBaselines.delete(id);
        this.usageStatus.set(id, { source: response.usage ? "ACP response" : "unavailable", cache: "unknown" });
        return withContext(response);
      }
      if (!queryUsage) {
        const batch = dbCursor === undefined ? undefined : await this.readModelUsageBatch(dbPath, dbCursor, signal);
        this.usageBaselines.delete(id);
        if (batch) {
          this.usageStatus.set(id, {
            source: `local session db (${batch.calls} call${batch.calls === 1 ? "" : "s"})`,
            cache: "reported",
          });
          return withContext({ ...response, usage: usageFromStepBatch(batch) });
        }
        this.usageStatus.set(id, { source: "unavailable", cache: "unknown" });
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
      try {
        deferred?.dispose();
        signal?.removeEventListener("abort", aborted);
        this.firstOutput?.delete(id);
        this.noticeClosed?.add(id);
        await this.emitHeldNotice(id, true);
      } catch {
        // A notification failure must not leak prompt accounting.
      } finally {
        this.noticeFilter?.forget(id);
        this.activePrompts--;
        try { await this.cleanup?.touch(id); } catch { /* Keep accounting optional. */ }
      }
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
    const selected = await this.setSelector(sessionId, thoughtSelector.id, effort, signal);
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
