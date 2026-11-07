// agy streams transport retries and its own output-cap continuation notice as
// assistant text. They are diagnostics, not model output, so keep them out of
// OMP's transcript without dropping a chunk that only looks like a prefix.
const AGENT_RETRY_NOTICE = /^\s*⚠\s*API error \(attempt \d+\)/i;
const OUTPUT_LIMIT_HEAD = "your previous response was cut off because it exceeded the output token limit";
const OUTPUT_LIMIT_TAIL = "please continue from where you left off, keeping your response shorter";

export type NoticeVerdict = "drop" | "hold" | "emit";

function noticeText(raw: string): string {
  return raw.replace(/⚠/g, " ").replace(/\bError:/gi, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

export function classifyOutputLimitNotice(raw: string): NoticeVerdict {
  const text = noticeText(raw);
  if (text.length === 0) return "emit";
  const stripped = text.replace(/\s*retries remaining:\s*\d*\s*$/i, "").trim();
  const retry = text.slice(stripped.length).trim();
  if (retry.length > 0 && !/^retries remaining:\s*\d*$/i.test(retry)) return "emit";
  if (stripped.length === 0) return /^retries remaining:\s*\d+$/i.test(text) ? "drop" : "emit";
  const full = `${OUTPUT_LIMIT_HEAD} ${OUTPUT_LIMIT_TAIL}`;
  if (stripped === full || stripped === OUTPUT_LIMIT_HEAD || stripped === OUTPUT_LIMIT_TAIL) return "drop";
  if (full.startsWith(stripped) && stripped.startsWith("your previous")) return "hold";
  if (OUTPUT_LIMIT_TAIL.startsWith(stripped) && stripped.startsWith("please continue from where you left off")) return "hold";
  if ("retries remaining:".startsWith(text) && text.startsWith("retries")) return "hold";
  return "emit";
}

// ACP notifications from several sessions share one connection callback, so
// the hold state is keyed by session and never leaks across streams.
export class AgentNoticeFilter {
  private readonly holds = new Map<string, string>();
  private readonly limitNotices = new Set<string>();
  dropped = 0;

  accept(sessionId: string, text: string): string | undefined {
    const combined = (this.holds.get(sessionId) ?? "") + text;
    const verdict = classifyOutputLimitNotice(combined);
    if (verdict === "hold") {
      this.holds.set(sessionId, combined);
      return undefined;
    }
    this.holds.delete(sessionId);
    if (verdict === "drop") {
      this.dropped++;
      this.limitNotices.add(sessionId);
      return undefined;
    }
    if (AGENT_RETRY_NOTICE.test(combined)) {
      this.dropped++;
      return undefined;
    }
    return combined;
  }

  // A thought chunk proves the held text was model output rather than the
  // start of agy's notice. A finished notice is counted and discarded.
  flush(sessionId: string): string | undefined {
    const held = this.holds.get(sessionId);
    if (held === undefined) return undefined;
    this.holds.delete(sessionId);
    if (classifyOutputLimitNotice(held) === "drop") {
      this.dropped++;
      this.limitNotices.add(sessionId);
      return undefined;
    }
    return held;
  }

  consumeOutputLimitNotice(sessionId: string): boolean {
    return this.limitNotices.delete(sessionId);
  }

  forget(sessionId: string): void {
    this.holds.delete(sessionId);
    this.limitNotices.delete(sessionId);
  }

  clear(): void {
    this.holds.clear();
    this.limitNotices.clear();
  }
}
