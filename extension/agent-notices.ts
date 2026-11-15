// agy streams transport retries, its output-cap continuation notice and its
// own ⚠ diagnostics as ordinary assistant text. They are agy's, not the
// model's, so they are only recognised as standalone complete lines at line
// boundaries and kept out of OMP's transcript without dropping a chunk that
// only looks like a prefix. The same words inside prose or a fenced code
// block are model text and pass through untouched. Terminal notices and
// RESOURCE_EXHAUSTED refusals are failure evidence without a log, so their
// text is captured for the connection to read once the stream ends
// (taxonomy adapted from opencode-antigravity-bridge, MIT, issue #49).
const AGENT_RETRY_NOTICE = /^\s*⚠\s*API error \(attempt \d+\)/i;
const OUTPUT_LIMIT_HEAD = "your previous response was cut off because it exceeded the output token limit";
const OUTPUT_LIMIT_TAIL = "please continue from where you left off, keeping your response shorter";

// agy's own ⚠ diagnostics arrive as plain assistant lines. The terminal
// notices mean the turn failed; the others describe internal retries, and a
// RESOURCE_EXHAUSTED banner is agy 1.5.9's refusal as an attempt-1 error.
const ERROR_LINE = "⚠ Agent execution terminated due to error.";
const NETWORK_LINE = "⚠ There was a network issue connecting to the server, please try again.";
const CREDITS_LINE = "⚠ Your AI credits balance is too low to continue.";
const INVALID_LINE = "⚠ Model produced invalid output.";
const INTERRUPT_LINE = "⚠ The stream was interrupted. Please continue the task you were working on.";
const API_HEAD = "⚠ API error (attempt ";
const EXHAUSTED_HEAD = "⚠ RESOURCE_EXHAUSTED (code ";
const API_FULL = /^⚠ API error \(attempt \d+\): /;
const EXHAUSTED_FULL = /^⚠ RESOURCE_EXHAUSTED \(code \d+\): /;
// The digits and closing punctuation that can still grow into a full head.
const API_PARTIAL = /^\d*(?:\)(?::(?: )?)?)?$/;
const FENCE_OPENER = /^\s*(?:```|~~~)/;
// A short backtick or tilde run may still grow into a fence opener.
const PARTIAL_FENCE = /^ {0,3}(?:`{1,2}|~{1,2})$/;
const DETAIL_LIMIT = 2000;

export type NoticeVerdict = "drop" | "hold" | "emit";

function noticeText(raw: string): string {
  return raw.replace(/⚠/g, " ").replace(/\bError:/gi, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

export function classifyOutputLimitNotice(raw: string): NoticeVerdict {
  const text = noticeText(raw);
  if (text.length === 0) return "emit";
  const stripped = text.replace(/\s*retries remaining:\s*\d*\s*$/i, "").trim();
  const retry = text.slice(stripped.length).trim();
  if (retry.length > 0 && !/^retries remaining:\s*\d+$/i.test(retry)) return "emit";
  if (stripped.length === 0) return /^retries remaining:\s*\d+$/i.test(text) ? "drop" : "emit";
  const full = `${OUTPUT_LIMIT_HEAD} ${OUTPUT_LIMIT_TAIL}`;
  if (stripped === full || stripped === OUTPUT_LIMIT_HEAD || stripped === OUTPUT_LIMIT_TAIL) return "drop";
  if (full.startsWith(stripped) && stripped.startsWith("your previous")) return "hold";
  if (OUTPUT_LIMIT_TAIL.startsWith(stripped) && stripped.startsWith("please continue from where you left off")) return "hold";
  if ("retries remaining:".startsWith(text) && text.startsWith("retries")) return "hold";
  return "emit";
}

// A 429 RESOURCE_EXHAUSTED detail is a quota refusal, not a retry.
export function isRefused429(detail: string | undefined): boolean {
  const text = String(detail ?? "");
  return /code 429\b/i.test(text) && /resource has been exhausted/i.test(text);
}

// Failure evidence the connection reads once the stream has ended: the first
// terminal banner, the latest API detail and the first 429 refusal detail.
export interface AgentNoticeCapture {
  readonly terminal: string | undefined;
  readonly apiDetail: string | undefined;
  readonly refusedDetail: string | undefined;
}

type LineKind = "emit" | "hold" | "fence" | "terminal" | "notice" | "api" | "limit";

interface LineState {
  // Trailing line that may still grow into a notice.
  pending: string;
  // The open line already reached the transcript as model text.
  midLine: boolean;
  // Inside a ``` / ~~~ fenced code block.
  fence: boolean;
}

interface SessionCapture {
  terminal?: string;
  apiDetail?: string;
  refusedDetail?: string;
}

// An incomplete line only counts as a notice candidate while it can still
// grow into one, allowing for trailing spaces before the line ends.
function couldBecome(line: string, notice: string): boolean {
  return notice.startsWith(line) || (line.trimEnd() === notice && line.length <= notice.length + 16);
}

// ACP notifications from several sessions share one connection callback, so
// the line state is keyed by session and never leaks across streams.
export class AgentNoticeFilter {
  private readonly lines = new Map<string, LineState>();
  private readonly limitNotices = new Set<string>();
  private readonly captures = new Map<string, SessionCapture>();
  dropped = 0;

  accept(sessionId: string, text: string): string | undefined {
    const state = this.lineState(sessionId);
    let rest = state.pending + text;
    state.pending = "";
    let out = "";
    let consumed = false;
    while (rest.length > 0) {
      if (state.midLine) {
        // The open line was already emitted as model text, so nothing in it
        // can start a standalone notice; only its end begins a new line.
        const end = rest.indexOf("\n");
        if (end < 0) {
          out += rest;
          break;
        }
        out += rest.slice(0, end);
        rest = rest.slice(end);
        state.midLine = false;
        continue;
      }
      const lead = rest[0] === "\n" ? "\n" : "";
      const body = rest.slice(lead.length);
      if (body.length === 0) {
        out += lead;
        break;
      }
      const end = body.indexOf("\n");
      const line = end < 0 ? body : body.slice(0, end);
      const kind = this.classify(state, line, end >= 0);
      if (kind === "hold") {
        state.pending = rest;
        consumed = true;
        break;
      }
      if (kind === "emit" || kind === "fence") {
        if (kind === "fence") state.fence = !state.fence;
        out += lead + line;
        if (end < 0) {
          state.midLine = true;
          break;
        }
        rest = body.slice(end);
        continue;
      }
      // A notice line is dropped together with its terminating newline; the
      // newline before it stays so surrounding model text keeps its shape.
      consumed = true;
      this.dropped++;
      if (kind === "terminal") this.recordTerminal(sessionId, line);
      else if (kind === "api") this.recordApiDetail(sessionId, line);
      else if (kind === "limit") this.limitNotices.add(sessionId);
      out += lead;
      if (end < 0) break;
      rest = body.slice(end + 1);
    }
    if (out.length > 0) return out;
    return consumed ? undefined : "";
  }

  // Releases held text at the end of a model step. A held line that finished
  // as a notice is counted and discarded; anything else is model text.
  flush(sessionId: string): string | undefined {
    const state = this.lines.get(sessionId);
    if (state === undefined) return undefined;
    const held = state.pending;
    if (held === "") return undefined;
    state.pending = "";
    const line = held[0] === "\n" ? held.slice(1) : held;
    const kind = this.classify(state, line, true);
    if (kind === "terminal" || kind === "notice" || kind === "api" || kind === "limit") {
      this.dropped++;
      if (kind === "terminal") this.recordTerminal(sessionId, line);
      else if (kind === "api") this.recordApiDetail(sessionId, line);
      else if (kind === "limit") this.limitNotices.add(sessionId);
      return undefined;
    }
    return held;
  }

  consumeOutputLimitNotice(sessionId: string): boolean {
    return this.limitNotices.delete(sessionId);
  }

  terminalNotice(sessionId: string): string | undefined {
    return this.captures.get(sessionId)?.terminal;
  }

  captured(sessionId: string): AgentNoticeCapture {
    const capture = this.captures.get(sessionId);
    return { terminal: capture?.terminal, apiDetail: capture?.apiDetail, refusedDetail: capture?.refusedDetail };
  }

  // Captures outlive forget(): a turn's banner is often only settled by the
  // final flush, after the per-turn forget has already run, so the finished
  // turn stays inspectable until the failure is reported.
  consumeCaptured(sessionId: string): AgentNoticeCapture {
    const record = this.captured(sessionId);
    this.captures.delete(sessionId);
    return record;
  }

  forget(sessionId: string): void {
    this.lines.delete(sessionId);
    this.limitNotices.delete(sessionId);
  }

  clear(): void {
    this.lines.clear();
    this.limitNotices.clear();
    this.captures.clear();
  }

  private lineState(sessionId: string): LineState {
    let state = this.lines.get(sessionId);
    if (state === undefined) {
      state = { pending: "", midLine: false, fence: false };
      this.lines.set(sessionId, state);
    }
    return state;
  }

  private sessionCapture(sessionId: string): SessionCapture {
    let capture = this.captures.get(sessionId);
    if (capture === undefined) {
      capture = {};
      this.captures.set(sessionId, capture);
    }
    return capture;
  }

  private recordTerminal(sessionId: string, line: string): void {
    const capture = this.sessionCapture(sessionId);
    if (capture.terminal === undefined) capture.terminal = line.trimEnd();
  }

  private recordApiDetail(sessionId: string, line: string): void {
    const capture = this.sessionCapture(sessionId);
    const detail = line.slice(0, DETAIL_LIMIT);
    capture.apiDetail = detail;
    if (capture.refusedDetail === undefined && isRefused429(detail)) capture.refusedDetail = detail;
  }

  private classify(state: LineState, line: string, complete: boolean): LineKind {
    if (FENCE_OPENER.test(line)) return "fence";
    // Everything inside a fence is model text and passes through untouched.
    if (state.fence) return "emit";
    if (complete && line.trimEnd() === ERROR_LINE) return "terminal";
    if (!complete && couldBecome(line, ERROR_LINE)) return "hold";
    if (complete && (line.trimEnd() === NETWORK_LINE || line.trimEnd() === CREDITS_LINE)) return "terminal";
    if (!complete && (couldBecome(line, NETWORK_LINE) || couldBecome(line, CREDITS_LINE))) return "hold";
    if (line.startsWith("⚠")) {
      if (complete && (line.trimEnd() === INTERRUPT_LINE || line.trimEnd() === INVALID_LINE)) return "notice";
      if (API_FULL.test(line) || EXHAUSTED_FULL.test(line) || AGENT_RETRY_NOTICE.test(line)) return "api";
      if (!complete) {
        if (couldBecome(line, INTERRUPT_LINE) || couldBecome(line, INVALID_LINE)) return "hold";
        if (API_HEAD.startsWith(line) || EXHAUSTED_HEAD.startsWith(line)) return "hold";
        if (line.startsWith(API_HEAD) && line.length <= API_HEAD.length + 16 && API_PARTIAL.test(line.slice(API_HEAD.length))) return "hold";
        if (line.startsWith(EXHAUSTED_HEAD) && line.length <= EXHAUSTED_HEAD.length + 16 && API_PARTIAL.test(line.slice(EXHAUSTED_HEAD.length))) return "hold";
      }
    } else if (!complete && PARTIAL_FENCE.test(line)) {
      return "hold";
    }
    const verdict = classifyOutputLimitNotice(line);
    if (verdict === "drop") return "limit";
    if (verdict === "hold" && !complete) return "hold";
    return "emit";
  }
}
