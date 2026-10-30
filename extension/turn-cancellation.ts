export interface SteerTimings {
  /** Longest silent stretch tolerated while waiting for a turn the server cannot cancel. */
  idleMs: number;
  /** Absolute cap on the whole wait; 0 keeps waiting while the turn stays alive. */
  maxMs: number;
}

export interface SteerActivitySource {
  onSteerActivity?(sessionId: string, listener: () => void): () => void;
}

interface PendingTurn {
  turnCompletion?: Promise<void>;
  session: { sessionId: string };
  connection: {
    cancel: (sessionId: string) => Promise<void>;
    muteSteerChunks?: (sessionId: string) => void;
    onSteerActivity?: (sessionId: string, listener: () => void) => () => void;
  };
}

// The official ACP server still lacks session/cancel (verified against
// agy_acp_server 1.4.3: -32601 Method not found), so an interrupted turn
// cannot be stopped. The steering grace instead waits for the old turn to end
// naturally, letting the adapter checkpoint the warm ACP session and send the
// new request as a delta instead of a full cold replay. The wait extends while
// the old turn keeps producing updates — long thinking or tool loops do not
// expire it — and only a silent gap beyond idleMs, or the absolute maxMs cap,
// gives up. idleMs 0 restores the legacy immediate-reconstruction behavior.
export function steerTimings(env: NodeJS.ProcessEnv = process.env): SteerTimings {
  const idleMs = Number(env.OMP_ACP_STEER_GRACE_MS ?? 60_000);
  if (!Number.isSafeInteger(idleMs) || idleMs < 0 || idleMs > 600_000) {
    throw new Error("OMP_ACP_STEER_GRACE_MS must be an integer between 0 and 600000");
  }
  const maxMs = Number(env.OMP_ACP_STEER_GRACE_MAX_MS ?? 300_000);
  if (!Number.isSafeInteger(maxMs) || maxMs < 0 || maxMs > 3_600_000 || (maxMs > 0 && maxMs < 100)) {
    throw new Error("OMP_ACP_STEER_GRACE_MAX_MS must be 0 or an integer between 100 and 3600000");
  }
  return { idleMs, maxMs };
}

function isCancelUnsupported(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === -32601) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /method not found/i.test(message);
}

// One activity-aware give-up clock shared by the drain and the deferred
// transport abort: every notification from the draining session resets the
// silence window, the absolute cap never moves, and the vendored progress
// watchdog (10 min silent / 60 min busy) remains the outer safety net.
export function armSteerGiveup(
  source: SteerActivitySource | undefined,
  sessionId: string,
  timings: SteerTimings,
  fire: () => void,
): { dispose: () => void } {
  const startedAt = Date.now();
  let lastActivity = startedAt;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const schedule = () => {
    if (done) return;
    clearTimeout(timer);
    const silenceDeadline = lastActivity + timings.idleMs;
    const hardDeadline = timings.maxMs > 0 ? startedAt + timings.maxMs : Number.POSITIVE_INFINITY;
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      detach?.();
      fire();
    }, Math.max(0, Math.min(silenceDeadline, hardDeadline) - Date.now()));
  };
  const detach = source?.onSteerActivity?.(sessionId, () => {
    lastActivity = Date.now();
    schedule();
  });
  schedule();
  return { dispose: () => { done = true; clearTimeout(timer); detach?.(); } };
}

// Keeps the vendored prompt transport alive after the caller aborts. The
// upstream prompt() closes the whole connection 1.5s after an abort, which
// would destroy the warm session before drainCancelledTurn can reuse it. The
// give-up follows the same activity clock as the drain, so a turn that is
// still producing output never loses its transport early.
export function deferredAbortSignal(
  signal: AbortSignal,
  timings: SteerTimings,
  activity?: { source: SteerActivitySource; sessionId: string },
): { signal: AbortSignal; dispose: () => void } {
  if (!(timings.idleMs > 0)) return { signal, dispose: () => undefined };
  const controller = new AbortController();
  let giveup: { dispose: () => void } | undefined;
  const onAbort = () => {
    if (giveup) return;
    giveup = armSteerGiveup(activity?.source, activity?.sessionId, timings, () => controller.abort(signal.reason));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return {
    signal: controller.signal,
    dispose: () => {
      giveup?.dispose();
      signal.removeEventListener("abort", onAbort);
    },
  };
}

// The caller decides whether the accepted transcript still matches. This only
// drains the old turn, never resolves an old tool result into a new writer.
export async function drainCancelledTurn(
  binding: PendingTurn,
  abort: () => void,
  signal?: AbortSignal,
  timeoutMs = 1500,
  timings: SteerTimings = steerTimings(),
): Promise<boolean> {
  const completion = binding.turnCompletion;
  if (!completion || signal?.aborted) return false;
  const deadline = Promise.withResolvers<boolean>();
  const cancelled = () => deadline.resolve(false);
  let timer = setTimeout(cancelled, timeoutMs);
  let giveup: { dispose: () => void } | undefined;
  signal?.addEventListener("abort", cancelled, { once: true });
  // Without session/cancel the old turn keeps running. Freeze what OMP has
  // retained so the checkpointed fingerprint still matches once it ends, and
  // wait for natural completion: the grace extends while the turn keeps
  // producing updates and only gives up after a silent gap or the hard cap.
  const extendForNaturalCompletion = () => {
    binding.connection.muteSteerChunks?.(binding.session.sessionId);
    clearTimeout(timer);
    giveup = armSteerGiveup(binding.connection, binding.session.sessionId, timings, cancelled);
  };
  try {
    abort();
    // A blocked cancel transport must not block the fallback deadline.
    try {
      void binding.connection.cancel(binding.session.sessionId).catch((error: unknown) => {
        if (timings.idleMs > 0 && isCancelUnsupported(error)) extendForNaturalCompletion();
        else deadline.resolve(false);
      });
    } catch (error) {
      if (timings.idleMs > 0 && isCancelUnsupported(error)) extendForNaturalCompletion();
      else return false;
    }
    return await Promise.race([completion.then(() => true, () => false), deadline.promise]);
  } finally {
    giveup?.dispose();
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancelled);
  }
}
