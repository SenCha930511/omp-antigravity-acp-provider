// OMP decides whether to retry from the assistant error text. Keep the
// transport's distinction between account exhaustion and a transient throttle
// visible instead of collapsing both into "protocol".
import { redactSensitiveText } from "./redact.ts";

export type AcpFailureCode =
  | "auth"
  | "quota"
  | "prompt_rejected"
  | "rate_limit"
  | "context"
  | "timeout"
  | "server"
  | "transport"
  | "protocol"
  | "model"
  | "refusal"
  | "aborted";

export interface AcpFailureContext {
  /** The session's instructions contained a phrase agy refuses regardless of quota. */
  promptFingerprinted?: boolean;
}

export class AcpFailure extends Error {
  constructor(readonly code: AcpFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AcpFailure";
  }
}

interface FailureRule {
  code: Exclude<AcpFailureCode, "aborted">;
  match: RegExp;
  ensure: RegExp;
  append: string;
}

const AUTH_RULE: FailureRule = {
  code: "auth",
  match: /authentication required|not logged in|not signed in|unauthenticated|sign in|invalid_grant|401 unauthorized/i,
  ensure: /run `agy`|terminal/i,
  append: "run `agy` once in a terminal to sign in, or verify HTTP_PROXY/HTTPS_PROXY if token refresh timed out",
};
const QUOTA_RULE: FailureRule = {
  code: "quota",
  match: /quota|resource.?exhausted|limit reached|exceeded your|insufficient_quota|out of budget|billing/i,
  ensure: /quota exceeded|insufficient_quota|billing/i,
  append: "quota exceeded",
};

// agy answers known third-party harness prompt lines with 429s whatever quota
// is left. When the session's instructions carried such a phrase, quota is the
// wrong explanation. Explicit metered-quota wording still wins, because the
// same 429 text also appears for genuine throttling and rate limits.
const PROMPT_REJECTED_RULE: FailureRule = {
  code: "prompt_rejected",
  match: /resource.?exhausted|code\s*[:=]?\s*429|http\s*429|too many requests/i,
  ensure: /fingerprint/i,
  append: "prompt fingerprint refused by Antigravity despite remaining quota",
};
const RATE_LIMIT_RULE: FailureRule = {
  code: "rate_limit",
  match: /rate.?limit|429|too many requests|overloaded|capacity|server_busy|high demand/i,
  ensure: /rate.?limit|429|too many requests/i,
  append: "rate limit",
};
const CONTEXT_RULE: FailureRule = {
  code: "context",
  match: /context (?:window|length|limit)|context_length_exceeded|too long|token limit|maximum.*tokens|prompt is too long/i,
  ensure: /context|token limit|too long/i,
  append: "context window exceeded",
};
const TIMEOUT_RULE: FailureRule = {
  code: "timeout",
  match: /timeout|timed out|deadline/i,
  ensure: /timeout|timed out/i,
  append: "timeout",
};
const PROTOCOL_RULE: FailureRule = {
  code: "protocol",
  match: /ownership was lost|unexpected permission mode|already running|already in progress|protocol/i,
  ensure: /protocol|ownership|permission mode|already/i,
  append: "protocol error",
};
const SERVER_RULE: FailureRule = {
  code: "server",
  match: /internal.?error|server.?error|5\d\d|service.?(?:is.?)?(?:temporarily.?)?unavailable/i,
  ensure: /server|5\d\d|unavailable/i,
  append: "server error",
};
const TRANSPORT_RULE: FailureRule = {
  code: "transport",
  match: /network|connection|fetch failed|socket|stream ended|closed|ENOTFOUND|EAI_AGAIN|broken pipe|EPIPE|failed to bind|process exited/i,
  ensure: /connection|network|socket|stream|bind|process|proxy/i,
  append: "connection/network error — check network or HTTP_PROXY/HTTPS_PROXY",
};
const OAUTH_NETWORK_REFRESH = /(?:token refresh failed due to network|oauth2\.googleapis\.com\/token[^:]*:\s*(?:EOF|unexpected EOF|context deadline exceeded|timeout|ENOTFOUND|EAI_AGAIN|connection|network))/i;
const RULES: FailureRule[] = [
  AUTH_RULE,
  QUOTA_RULE,
  RATE_LIMIT_RULE,
  CONTEXT_RULE,
  TIMEOUT_RULE,
  PROTOCOL_RULE,
  SERVER_RULE,
  TRANSPORT_RULE,
];

function appendHint(message: string, rule: FailureRule): string {
  return rule.ensure.test(message) ? message : `${message} (${rule.append})`;
}
interface AntigravityAcpErrorLike extends Error {
  name: "AntigravityAcpError";
  code: string;
}

function isAntigravityAcpError(error: unknown): error is AntigravityAcpErrorLike {
  return error instanceof Error && error.name === "AntigravityAcpError"
    && typeof (error as { code?: unknown }).code === "string";
}

function sanitizedCause(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = new Error(redactSensitiveText(message));
  if (error instanceof Error) {
    sanitized.name = error.name;
    if (error.stack) sanitized.stack = redactSensitiveText(error.stack);
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") Object.assign(sanitized, { code });
  }
  return sanitized;
}

function needsSanitization(error: unknown): boolean {
  return error instanceof Error
    && (error.cause !== undefined || Boolean(error.stack && redactSensitiveText(error.stack) !== error.stack));
}

function sanitizedError(error: unknown): Error {
  const sanitized = sanitizedCause(error);
  if (error instanceof Error && error.cause !== undefined) sanitized.cause = sanitizedCause(error.cause);
  return sanitized;
}

export function classifyAcpFailure(error: unknown, context: AcpFailureContext = {}): Error {
  if (isAntigravityAcpError(error)) {
    if (error.code === "aborted") return error;
    const cause = { cause: sanitizedCause(error) };
    if (error.code === "auth") return new AcpFailure("auth", redactSensitiveText(appendHint(error.message, AUTH_RULE)), cause);
    if (error.code === "quota") {
      if (context.promptFingerprinted && !QUOTA_RULE.ensure.test(error.message) && PROMPT_REJECTED_RULE.match.test(error.message)) {
        return new AcpFailure("prompt_rejected", redactSensitiveText(appendHint(error.message, PROMPT_REJECTED_RULE)), cause);
      }
      return new AcpFailure("quota", redactSensitiveText(appendHint(error.message, QUOTA_RULE)), cause);
    }
    if (error.code === "timeout") return new AcpFailure("timeout", redactSensitiveText(appendHint(error.message, TIMEOUT_RULE)), cause);
    if (error.code === "spawn" || error.code === "process_exit") return new AcpFailure("transport", redactSensitiveText(appendHint(error.message, TRANSPORT_RULE)), cause);
    if ((error.code === "protocol" || error.code === "invalid_input")
      && OAUTH_NETWORK_REFRESH.test(error.message) && !/invalid_grant/i.test(error.message)) {
      return new AcpFailure("transport", redactSensitiveText(appendHint(error.message, TRANSPORT_RULE)), cause);
    }
    if (error.code === "protocol" || error.code === "invalid_input") return new AcpFailure("protocol", redactSensitiveText(appendHint(error.message, PROTOCOL_RULE)), cause);
    if (error.code === "model") return new AcpFailure("model", redactSensitiveText(error.message), cause);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!message.trim()) return needsSanitization(error) ? sanitizedError(error) : error instanceof Error ? error : new Error(message);
  if (OAUTH_NETWORK_REFRESH.test(message) && !/invalid_grant/i.test(message)) {
    return new AcpFailure("transport", redactSensitiveText(appendHint(message, TRANSPORT_RULE)), { cause: sanitizedCause(error) });
  }
  if (context.promptFingerprinted && !QUOTA_RULE.ensure.test(message) && PROMPT_REJECTED_RULE.match.test(message)) {
    return new AcpFailure("prompt_rejected", redactSensitiveText(appendHint(message, PROMPT_REJECTED_RULE)), { cause: sanitizedCause(error) });
  }
  for (const rule of RULES) {
    if (rule.match.test(message)) {
      return new AcpFailure(rule.code, redactSensitiveText(appendHint(message, rule)), { cause: sanitizedCause(error) });
    }
  }
  const redacted = redactSensitiveText(message);
  const needs = needsSanitization(error);
  if (redacted === message && !needs) return error instanceof Error ? error : new Error(message);
  return redacted === message ? sanitizedError(error) : new Error(redacted);
}
