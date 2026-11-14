import { test } from "node:test";
import assert from "node:assert/strict";
import { AcpFailure, classifyAcpFailure } from "../extension/acp-errors.ts";
import { AntigravityAcpError, redactTail } from "../extension/runtime/acp/errors.ts";

function classify(message: string): AcpFailure {
  const failure = classifyAcpFailure(new Error(message));
  assert.ok(failure instanceof AcpFailure, `expected a classified failure for ${message}`);
  return failure;
}

test("auth failures carry the terminal sign-in hint", () => {
  const failure = classify("Antigravity authentication required: token expired");
  assert.equal(failure.code, "auth");
  assert.match(failure.message, /run `agy` once in a terminal/);
});

test("quota exhaustion stays non-retryable while throttling stays retryable", () => {
  const quota = classify("You exceeded your monthly limit");
  assert.equal(quota.code, "quota");
  assert.match(quota.message, /quota exceeded/);

  const rate = classify("upstream is overloaded");
  assert.equal(rate.code, "rate_limit");
  assert.match(rate.message, /rate limit/);
});

test("context, timeout, server and transport failures remain distinguishable", () => {
  assert.equal(classify("prompt is too long for this model").code, "context");
  assert.equal(classify("request timed out after 5000ms").code, "timeout");
  assert.equal(classify("Antigravity ACP error 503: service unavailable").code, "server");
  assert.equal(classify("socket hang up").code, "transport");
  assert.equal(classify("ACP session ownership was lost").code, "protocol");
});

test("vendor codes survive when the message is ambiguous", () => {
  assert.equal(classifyAcpFailure(new AntigravityAcpError("aborted", "cancelled")).code, "aborted");
  assert.equal(classifyAcpFailure(new AntigravityAcpError("spawn", "bridge failed to bind")).code, "transport");
  const quota = classifyAcpFailure(new AntigravityAcpError("quota", "Account depleted. Resets at 2026-11-12T01:02:00.000Z"));
  assert.equal(quota.code, "quota");
  assert.match(quota.message, /quota exceeded/);
  assert.match(quota.message, /Resets at 2026-11-12T01:02:00\.000Z/);
  assert.equal(classifyAcpFailure(new AntigravityAcpError("invalid_input", "bad request")).code, "protocol");
  assert.equal(classifyAcpFailure(new AntigravityAcpError("model", "model unavailable")).code, "model");
});

test("protocol errors are classified without relying on the message", () => {
  const failure = classifyAcpFailure(new AntigravityAcpError("protocol", "malformed frame"));
  assert.ok(failure instanceof AcpFailure);
  assert.equal(failure.code, "protocol");
  assert.match(failure.message, /protocol error/u);
});

test("unknown errors with a sensitive cause or stack are sanitized", () => {
  const cause = new Error("access_token=secret-token");
  const original = new Error("something unusual", { cause });
  const classified = classifyAcpFailure(original);
  assert.notEqual(classified, original);
  assert.equal(classified.message, "something unusual");
  const sanitized = classified.cause as Error;
  assert.ok(sanitized instanceof Error);
  assert.doesNotMatch(sanitized.message, /secret-token/u);
  assert.doesNotMatch(sanitized.stack ?? "", /secret-token/u);

  const empty = new Error("", { cause });
  const emptyClassified = classifyAcpFailure(empty);
  assert.notEqual(emptyClassified, empty);
  assert.doesNotMatch((emptyClassified.cause as Error).message, /secret-token/u);

  const stacked = new Error("something unusual");
  stacked.stack = "Error: something unusual\n    at access_token=secret-token";
  const stackClassified = classifyAcpFailure(stacked);
  assert.notEqual(stackClassified, stacked);
  assert.doesNotMatch(stackClassified.stack ?? "", /secret-token/u);
});

test("unknown failures are left untouched", () => {
  const original = new Error("something unusual");
  assert.equal(classifyAcpFailure(original), original);
});

test("classified failures do not retain the raw credential-bearing cause", () => {
  const failure = classifyAcpFailure(new AntigravityAcpError("auth", "login failed access_token=secret-token"));
  assert.match(failure.message, /access_token=\*\*\*/u);
  const cause = failure.cause as Error;
  assert.doesNotMatch(cause.message, /secret-token/u);
  assert.doesNotMatch(cause.stack ?? "", /secret-token/u);
});

test("redactTail keeps the newest output and still masks secrets", () => {
  const text = `BEGIN ${"old output ".repeat(600)}crash access_token=secret-value`;
  const tail = redactTail(text);
  assert.equal(tail.length <= 4_096, true);
  assert.match(tail, /crash access_token=<redacted>$/u);
  assert.doesNotMatch(tail, /BEGIN/u);
});
