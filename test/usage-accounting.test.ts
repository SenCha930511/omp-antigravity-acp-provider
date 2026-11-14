import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliUsageQuota, parseSessionUsage, parseUsageQuota, quotaExhaustion, usageDelta } from "../extension/usage-accounting.ts";

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

test("CRLF quota reports and exhaustion notices parse like LF", () => {
  const now = Date.UTC(2026, 10, 10, 12);
  const report = [
    "### Quota Limits",
    "- **Gemini 4 Argon**",
    "  - **Five hour limit:** 42% remaining (resets Nov 10, 2026, 18:30 UTC)",
  ].join("\r\n");
  const parsed = parseUsageQuota(report, now);
  assert.equal(parsed.groups[0]!.buckets[0]!.remainingFraction, 0.42);
  assert.equal(parsed.groups[0]!.buckets[0]!.resetTime, "2026-11-10T18:30:00.000Z");
  assert.deepEqual(quotaExhaustion("Usage Limit Reached\r\n\r\nYou have reached your current quota for this period. Your limit will reset in 2 hours.", now), {
    resetAt: new Date(now + 2 * 3_600_000).toISOString(),
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

test("CLI quota output preserves tab-separated groups and reset timestamps", () => {
  const now = Date.UTC(2026, 10, 10, 12);
  assert.deepEqual(parseCliUsageQuota([
    "Gemini Models\tWeekly Limit Remaining\t40%\t2026-11-14T13:50:05Z",
    "Gemini Models\tFive Hour Limit Remaining\t96%\t2026-11-12T20:51:50Z",
    "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-16T05:58:33Z",
    "Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t23%\t2026-11-14T13:38:33Z",
  ].join("\n"), now), {
    at: now,
    groups: [
      { displayName: "Gemini Models", buckets: [
        { window: "weekly", remainingFraction: 0.4, resetTime: "2026-11-14T13:50:05.000Z" },
        { window: "5h", remainingFraction: 0.96, resetTime: "2026-11-12T20:51:50.000Z" },
      ] },
      { displayName: "Claude and GPT models", buckets: [
        { window: "weekly", remainingFraction: 1, resetTime: "2026-11-16T05:58:33.000Z" },
      ] },
      { displayName: "Gemini 4 Argon", buckets: [
        { window: "weekly", remainingFraction: 0.23, resetTime: "2026-11-14T13:38:33.000Z" },
      ] },
    ],
  });
});

test("CLI quota parser rejects malformed percentages, reset times, and empty output", () => {
  assert.throws(() => parseCliUsageQuota("Gemini Models\tWeekly\t120%\t2026-11-14T13:50:05Z"), /invalid percentage/);
  assert.throws(() => parseCliUsageQuota("Gemini Models\tWeekly\t40%\tnot-a-date"), /invalid reset time/);
  assert.throws(() => parseCliUsageQuota(""), /no quota groups: no text returned/);
  assert.throws(() => parseCliUsageQuota("no quota summary is available"), /no quota groups: unrecognized format/);
});

test("CLI reset timestamps require a valid calendar and explicit timezone", () => {
  for (const reset of ["2026-02-30T00:00:00Z", "2026-11-14T13:50:05", "2026-13-01T00:00:00Z", "not-a-date"]) {
    assert.throws(() => parseCliUsageQuota(`Gemini Models\tWeekly\t40%\t${reset}`), /invalid reset time/);
  }
  assert.deepEqual(parseCliUsageQuota("Gemini Models\tWeekly\t40%\t2024-02-29T10:00:00+01:30").groups[0]!.buckets, [
    { window: "weekly", remainingFraction: 0.4, resetTime: "2024-02-29T08:30:00.000Z" },
  ]);
});

test("CLI reset timestamps accept subsecond precision beyond milliseconds", () => {
  for (const [fraction, milliseconds] of [["654321", "654"], ["123456789", "123"]]) {
    const snapshot = parseCliUsageQuota(`Gemini Models\tWeekly Limit Remaining\t50%\t2024-02-29T09:45:10.${fraction}+01:30`);
    assert.deepEqual(snapshot.groups[0]!.buckets, [{
      window: "weekly",
      remainingFraction: 0.5,
      resetTime: `2024-02-29T08:15:10.${milliseconds}Z`,
    }]);
  }
});

test("ACP quota percentages must be finite and within zero to one", () => {
  for (const percent of ["120", "9".repeat(400)]) {
    const input = `### Quota Limits\n- **Gemini Models**\n  - **weekly:** ${percent}% remaining`;
    assert.throws(() => parseUsageQuota(input), /invalid percentage/);
  }
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
