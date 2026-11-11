// OMP decides whether to retry from the assistant error text. Keep the
// transport's distinction between account exhaustion and a transient throttle
// visible instead of collapsing both into "protocol".
import { redactSensitiveText } from "./redact.ts";

export type AcpFailureCode =
  | "auth"
  | "quota"
  | "rate_limit"
  | "context"
  | "timeout"
  | "server"
  | "transport"
  | "protocol"
  | "model"
  | "refusal"
  | "aborted";

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
  append: "run `agy` once in a terminal to sign in",
};
const QUOTA_RULE: FailureRule = {
  code: "quota",
  match: /quota|resource.?exhausted|limit reached|exceeded your|insufficient_quota|out of budget|billing/i,
  ensure: /quota exceeded|insufficient_quota|billing/i,
  append: "quota exceeded",
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
  ensure: /connection|network|socket|stream|bind|process/i,
  append: "connection error",
};
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

export function classifyAcpFailure(error: unknown): Error {
  if (isAntigravityAcpError(error)) {
    if (error.code === "aborted") return error;
    if (error.code === "auth") return new AcpFailure("auth", redactSensitiveText(appendHint(error.message, AUTH_RULE)), { cause: error });
    if (error.code === "quota") return new AcpFailure("quota", redactSensitiveText(appendHint(error.message, QUOTA_RULE)), { cause: error });
    if (error.code === "timeout") return new AcpFailure("timeout", redactSensitiveText(appendHint(error.message, TIMEOUT_RULE)), { cause: error });
    if (error.code === "spawn" || error.code === "process_exit") return new AcpFailure("transport", redactSensitiveText(appendHint(error.message, TRANSPORT_RULE)), { cause: error });
    if (error.code === "invalid_input") return new AcpFailure("protocol", redactSensitiveText(appendHint(error.message, PROTOCOL_RULE)), { cause: error });
    if (error.code === "model") return new AcpFailure("model", redactSensitiveText(error.message), { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!message.trim()) return error instanceof Error ? error : new Error(message);
  for (const rule of RULES) {
    if (rule.match.test(message)) return new AcpFailure(rule.code, redactSensitiveText(appendHint(message, rule)), { cause: error });
  }
  const redacted = redactSensitiveText(message);
  if (redacted === message) return error instanceof Error ? error : new Error(message);
  return new Error(redacted);
}
