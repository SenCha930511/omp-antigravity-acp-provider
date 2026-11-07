import { test } from "node:test";
import assert from "node:assert/strict";
import { AcpFailure, classifyAcpFailure } from "../extension/acp-errors.ts";
import { AntigravityAcpError } from "../extension/vendor/pi-antigravity-acp-provider/src/acp/errors.ts";

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
  assert.equal(classifyAcpFailure(new AntigravityAcpError("invalid_input", "bad request")).code, "protocol");
});

test("unknown failures are left untouched", () => {
  const original = new Error("something unusual");
  assert.equal(classifyAcpFailure(original), original);
});
