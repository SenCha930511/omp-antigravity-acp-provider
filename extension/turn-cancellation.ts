export interface SteerTimings {
  /** Longest silent stretch tolerated while waiting for a turn the server cannot cancel. */
  idleMs: number;
  /** Absolute cap on the whole wait; 0 keeps waiting while the turn stays alive. */
  maxMs: number;
}

export type SteerMode = "steer" | "queue";

// Queue mode keeps the active ACP turn alive and sends the next user message
// as a warm delta after it finishes. Steer mode keeps the original interrupt
// behavior for callers that explicitly want it.
export function steerMode(env: NodeJS.ProcessEnv = process.env): SteerMode {
  const value = env.OMP_ACP_STEER_MODE?.trim().toLowerCase();
  if (!value || value === "queue") return "queue";
  if (value === "steer") return "steer";
  throw new Error("OMP_ACP_STEER_MODE must be steer or queue");
}

// OMP aborts a steering turn with a reason-less AbortController. User cancels
// and internal interrupts carry an explicit reason and must still stop work.
export function isSteerAbort(signal: AbortSignal): boolean {
  const reason = signal.reason;
  return reason === undefined || (reason instanceof Error && reason.name === "AbortError");
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

// session/cancel is a notification: the server may acknowledge it and still
// send final updates before the prompt terminates. The steering grace therefore
// waits for the terminal response, letting the adapter checkpoint the warm ACP
// session and send the new request as a delta instead of a full cold replay.
// The wait extends while the old turn keeps producing updates — long thinking
// or tool loops do not expire it — and only a silent gap beyond idleMs, or the
// absolute maxMs cap, gives up. idleMs 0 restores the legacy immediate
// reconstruction behavior.
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

// Keeps the vendored prompt transport alive after a queue-steering abort. The
// upstream prompt() closes the whole connection 1.5s after an abort, which
// would destroy the warm session before drainCancelledTurn can reuse it. The
// give-up follows the same activity clock as the drain, so a turn that is
// still producing output never loses its transport early. immediateOnAbort
// skips the hold for explicit user/internal cancellation, where the upstream
// prompt must send session/cancel at once.
export function deferredAbortSignal(
  signal: AbortSignal,
  timings: SteerTimings,
  activity?: { source: SteerActivitySource; sessionId: string },
  holdOnAbort?: () => boolean,
  immediateOnAbort?: () => boolean,
): { signal: AbortSignal; dispose: () => void } {
  if (!(timings.idleMs > 0)) return { signal, dispose: () => undefined };
  const controller = new AbortController();
  let giveup: { dispose: () => void } | undefined;
  const onAbort = () => {
    if (giveup) return;
    if (holdOnAbort?.()) return;
    if (immediateOnAbort?.()) {
      controller.abort(signal.reason);
      return;
    }
    giveup = armSteerGiveup(activity?.source, activity?.sessionId ?? "", timings, () => controller.abort(signal.reason));
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  let giveup: { dispose: () => void } | undefined;
  let finished = false;
  let cancelSettled = false;
  signal?.addEventListener("abort", cancelled, { once: true });
  // session/cancel is an ACP notification: a successful send only means the
  // server received it, not that the prompt already stopped. Freeze retained
  // output and wait for the terminal response under the same activity-aware
  // grace. The initial timer only bounds a transport that never sends.
  const extendForNaturalCompletion = () => {
    if (finished || giveup) return;
    binding.connection.muteSteerChunks?.(binding.session.sessionId);
    clearTimeout(timer);
    giveup = armSteerGiveup(binding.connection, binding.session.sessionId, timings, cancelled);
  };
  timer = setTimeout(() => {
    // A slow cancel RPC is not the same as a transport that never sent the
    // notification. Give an unacknowledged-but-pending cancel the same grace
    // as an acknowledged one before deciding to rebuild.
    if (!cancelSettled && timings.idleMs > 0) extendForNaturalCompletion();
    else cancelled();
  }, timeoutMs);
  try {
    abort();
    // A blocked cancel transport must not block the fallback deadline.
    void (async () => {
      try {
        await binding.connection.cancel(binding.session.sessionId);
        cancelSettled = true;
        if (timings.idleMs > 0) extendForNaturalCompletion();
        else deadline.resolve(false);
      } catch (error) {
        cancelSettled = true;
        if (timings.idleMs > 0 && isCancelUnsupported(error)) extendForNaturalCompletion();
        else deadline.resolve(false);
      }
    })();
    return await Promise.race([completion.then(() => true, () => false), deadline.promise]);
  } finally {
    finished = true;
    giveup?.dispose();
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancelled);
  }
}
