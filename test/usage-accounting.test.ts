import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessionUsage, parseUsageQuota, quotaExhaustion, usageDelta } from "../extension/usage-accounting.ts";

test("official cumulative counts include thinking in output without inventing cache hits", () => {
  const usage = parseSessionUsage("### Session Usage\n- **Session total:** 12,163 tokens (prompt: 11,869, completion: 109, thinking: 185)")!;
  assert.deepEqual(usageDelta({ input: 0, completion: 0, thinking: 0, cached: 0, total: 0 }, usage), {
    inputTokens: 11869, outputTokens: 294, thoughtTokens: 185, totalTokens: 12163,
  });
});
test("only per-turn deltas are charged, cached input remains a subset of input", () => {
  const a = { input: 1000, completion: 10, thinking: 20, cached: 500, total: 1030 };
  const b = { input: 3000, completion: 40, thinking: 60, cached: 1800, total: 3100 };
  assert.deepEqual(usageDelta(a, b), { inputTokens: 2000, outputTokens: 70, thoughtTokens: 40, totalTokens: 2070, cachedReadTokens: 1300 });
  assert.equal(usageDelta(b, a), undefined);
});
test("missing zero fields are valid but missing, malformed and inconsistent totals are unknown", () => {
  assert.equal(parseSessionUsage("**Session total:** data not available yet"), undefined);
  assert.equal(parseSessionUsage("**Session total:** 50 tokens (prompt: 40, completion: 11)"), undefined);
  assert.equal(parseSessionUsage("**Session total:** 50 tokens (prompt: 50, cached: 60)"), undefined);
  assert.equal(parseSessionUsage("**Session total:** 50 tokens (prompt: 50)")?.completion, 0);
});
test("unknown future usage categories do not hide known counts", () => {
  const usage = parseSessionUsage("**Session total:** 50 tokens (prompt: 40, completion: 5, thinking: 2, grounding: 3)");
  assert.deepEqual(usage, { input: 40, completion: 5, thinking: 2, cached: undefined, total: 50 });
});

test("quota groups preserve percentages and turn UTC reset labels into ISO timestamps", () => {
  const now = Date.UTC(2026, 10, 10, 12);
  assert.deepEqual(parseUsageQuota([
    "## Antigravity Usage",
    "### Quota Limits",
    "- **Gemini 4 Argon**",
    "  - **Five hour limit:** 42% remaining (resets Nov 10, 2026, 18:30 UTC)",
    "  - **Weekly limit:** 75% remaining",
    "- **Gemini 3.8 Flash**",
    "  - **Requests:** 25 Available",
    "### Session Usage",
    "**Session total:** 0 tokens (prompt: 0)",
  ].join("\n"), now), {
    at: now,
    groups: [
      { displayName: "Gemini 4 Argon", buckets: [
        { window: "5h", remainingFraction: 0.42, resetTime: "2026-11-10T18:30:00.000Z" },
        { window: "weekly", remainingFraction: 0.75 },
      ] },
      { displayName: "Gemini 3.8 Flash", buckets: [] },
    ],
  });
});

test("quota reset timestamps reject impossible dates and times while retaining legitimate leap days", () => {
  const report = (reset: string) => [
    "### Quota Limits", "- **Gemini 4 Argon**",
    `  - **Five hour limit:** 42% remaining (resets ${reset})`,
  ].join("\n");
  assert.equal(parseUsageQuota(report("Feb 29, 2024, 23:59 UTC")).groups[0]!.buckets[0]!.resetTime,
    "2024-02-29T23:59:00.000Z");
  for (const reset of ["Feb 29, 2023, 23:59 UTC", "Apr 31, 2026, 12:00 UTC", "Nov 10, 2026, 24:00 UTC", "Nov 10, 2026, 12:60 UTC"]) {
    assert.throws(() => parseUsageQuota(report(reset)), /invalid quota reset time/);
  }
});

test("quota parser rejects an empty group report instead of inventing availability", () => {
  assert.throws(() => parseUsageQuota("### Quota Limits\n- quota temporarily unavailable"),
    /no quota groups: quota temporarily unavailable/);
  assert.throws(() => parseUsageQuota("### Session Usage"), /no quota groups: unrecognized format \(17 characters\)/);
  assert.throws(() => parseUsageQuota(""), /no quota groups: no text returned/);
});

test("quota exhaustion accepts relative and absolute reset times only on the official notice", () => {
  const now = Date.UTC(2026, 10, 10, 12);
  assert.deepEqual(quotaExhaustion("Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 2 hours, 3 minutes.", now), {
    resetAt: "2026-11-10T14:03:00.000Z",
  });
  assert.deepEqual(quotaExhaustion("Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset on Nov 12, 2026 01:02 UTC."), {
    resetAt: "2026-11-12T01:02:00.000Z",
  });
  assert.deepEqual(quotaExhaustion("Usage Limit Reached\n\nYou have reached your current quota for this period."), {});
  assert.deepEqual(quotaExhaustion("Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset when the next billing window opens.", now), {},
    "an exact official notice with unknown reset wording is still quota exhaustion");
  assert.deepEqual(quotaExhaustion("Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset on Feb 29, 2023 01:02 UTC.", now), {});
  assert.deepEqual(quotaExhaustion(`Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in ${"9".repeat(400)} days.`, now), {},
    "an unrepresentable reset period remains a quota error without a fabricated timestamp");
  assert.equal(quotaExhaustion("Usage Limit Reached\n\nUnrelated text"), undefined);
  assert.equal(quotaExhaustion("A quoted notice follows\nUsage Limit Reached\n\nYou have reached your current quota for this period."), undefined);
});
