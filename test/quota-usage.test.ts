import { test } from "node:test";
import assert from "node:assert/strict";
import { createQuotaUsageProvider, quotaSnapshotToUsageReport } from "../extension/quota-usage.ts";
import type { AntigravityQuotaSnapshot } from "../extension/usage-accounting.ts";

const AT = Date.UTC(2026, 10, 13, 12);
const RESET = "2026-11-13T18:30:00.000Z";

const snapshot: AntigravityQuotaSnapshot = {
  at: AT,
  groups: [
    {
      displayName: "Gemini 4 Argon",
      buckets: [
        { window: "5h", remainingFraction: 0.42, resetTime: RESET },
        { window: "weekly", remainingFraction: 0.75 },
      ],
    },
    { displayName: "Gemini 3.8 Flash", buckets: [{ window: "daily", remainingFraction: 0.05 }] },
    { displayName: "Claude 4.5 Sonnet", buckets: [{ window: "weekly", remainingFraction: 0 }] },
  ],
};

test("quota snapshot maps groups, windows, amounts, resets and statuses", () => {
  const report = quotaSnapshotToUsageReport(snapshot);
  assert.equal(report.provider, "antigravity-acp");
  assert.equal(report.fetchedAt, AT);
  assert.deepEqual(report.metadata, { source: "antigravity-acp-quota", groups: 3 });
  assert.equal(report.limits.length, 4);

  const fiveHour = report.limits[0]!;
  assert.equal(fiveHour.scope.provider, "antigravity-acp");
  assert.equal(fiveHour.scope.tier, "Gemini 4 Argon");
  assert.equal(fiveHour.scope.windowId, "5h");
  assert.equal(fiveHour.window?.id, "5h");
  assert.equal(fiveHour.window?.label, "5 Hour");
  assert.equal(fiveHour.window?.durationMs, 18_000_000);
  assert.equal(fiveHour.window?.resetsAt, Date.parse(RESET));
  assert.equal(fiveHour.amount.unit, "percent");
  assert.equal(fiveHour.amount.remainingFraction, 0.42);
  assert.ok(Math.abs(fiveHour.amount.usedFraction - 0.58) < 1e-9);
  assert.equal(fiveHour.amount.remaining, 42);
  assert.ok(Math.abs(fiveHour.amount.used - 58) < 1e-9);
  assert.equal(fiveHour.amount.limit, 100);
  assert.equal(fiveHour.status, "ok");

  const weekly = report.limits[1]!;
  assert.equal(weekly.window?.id, "7d");
  assert.equal(weekly.window?.label, "7 Day");
  assert.equal(weekly.window?.durationMs, 604_800_000);
  assert.equal(weekly.window?.resetsAt, undefined);

  const daily = report.limits[2]!;
  assert.equal(daily.window?.id, "daily");
  assert.equal(daily.window?.label, "Daily");
  assert.equal(daily.window?.durationMs, 86_400_000);
  assert.equal(daily.status, "warning");

  assert.equal(report.limits[3]!.status, "exhausted");
  assert.equal(report.limits[3]!.amount.remainingFraction, 0);
  assert.equal(report.limits[3]!.amount.usedFraction, 1);

  assert.equal(new Set(report.limits.map(limit => limit.id)).size, report.limits.length);
});

test("single-model and shared-family groups map to their actual model IDs", () => {
  const report = quotaSnapshotToUsageReport(snapshot, {
    modelIds: ["gemini-4-argon", "gemini-3.8-flash", "claude-4.5-sonnet", "gpt-5"],
  });
  const argon = report.limits.filter(limit => limit.scope.tier === "Gemini 4 Argon");
  assert.deepEqual(argon.map(limit => limit.scope.modelId), ["gemini-4-argon", "gemini-4-argon"]);
  assert.equal(report.limits[2]!.scope.modelId, "gemini-3.8-flash");
  const claude = report.limits.find(limit => limit.scope.tier === "Claude 4.5 Sonnet")!;
  assert.equal(claude.scope.modelId, "claude-4.5-sonnet");
  const multi = quotaSnapshotToUsageReport({
    at: AT,
    groups: [{ displayName: "Claude and GPT models", buckets: [{ window: "weekly", remainingFraction: 0.5 }] }],
  }, { modelIds: ["claude-4.5-sonnet", "gpt-5"] });
  assert.deepEqual(multi.limits.map(limit => limit.scope.modelId), ["claude-4.5-sonnet", "gpt-5"]);
  assert.deepEqual(multi.limits.map(limit => limit.label), [
    "Claude and GPT models (claude-4.5-sonnet) 7 Day",
    "Claude and GPT models (gpt-5) 7 Day",
  ]);
  const gpt = quotaSnapshotToUsageReport({
    at: AT,
    groups: [{ displayName: "GPT-5", buckets: [{ window: "weekly", remainingFraction: 0.5 }] }],
  }, { modelIds: ["claude-4.5-sonnet", "gpt-5"] });
  assert.equal(gpt.limits[0]!.scope.modelId, "gpt-5");
});

test("exact model labels take precedence over broader Gemini family matches", () => {
  const report = quotaSnapshotToUsageReport({
    at: AT,
    groups: [
      { displayName: "Gemini Models", buckets: [{ window: "weekly", remainingFraction: 0.4 }] },
      { displayName: "Gemini 3.8 Flash", buckets: [{ window: "daily", remainingFraction: 0.6 }] },
    ],
  }, { modelIds: ["gemini-3.8-flash", "gemini-3.8-flash-lite", "claude-4.5-sonnet"] });
  assert.deepEqual(report.limits.map(limit => limit.scope.modelId), [
    "gemini-3.8-flash",
    "gemini-3.8-flash-lite",
    "gemini-3.8-flash",
  ]);
});

test("unknown windows stay as a slug with no duration", () => {
  const report = quotaSnapshotToUsageReport({
    at: AT,
    groups: [{ displayName: "Gemini 3 Pro", buckets: [{ window: "Gemini 3 Pro", remainingFraction: 0.5 }] }],
  });
  const limit = report.limits[0]!;
  assert.equal(limit.window?.id, "gemini-3-pro");
  assert.equal(limit.window?.label, "Gemini 3 Pro");
  assert.equal(limit.window?.durationMs, undefined);
  assert.equal(limit.scope.windowId, "gemini-3-pro");
});

test("provider maps a snapshot into a usage report", async () => {
  const provider = createQuotaUsageProvider({ loadSnapshot: async () => snapshot });
  assert.equal(provider.id, "antigravity-acp");
  assert.equal(provider.cacheVersion, 2);
  assert.equal(provider.validatesCredentials, false);
  assert.equal(provider.retainLastGoodOnFailure, true);
  assert.equal(provider.failureBackoffMs, 60_000);
  const report = await provider.fetchUsage({}, {});
  assert.equal(report?.provider, "antigravity-acp");
  assert.equal(report?.limits.length, 4);
});

test("provider caches successful reports for the TTL and coalesces concurrent reads", async () => {
  let calls = 0;
  let clock = 1_000;
  const provider = createQuotaUsageProvider({
    loadSnapshot: async () => {
      calls++;
      return snapshot;
    },
    now: () => clock,
    ttlMs: 60_000,
  });
  const [first, concurrent] = await Promise.all([
    provider.fetchUsage({}, {}),
    provider.fetchUsage({}, {}),
  ]);
  assert.equal(first, concurrent);
  assert.equal(calls, 1);
  clock += 59_999;
  assert.equal(await provider.fetchUsage({}, {}), first);
  assert.equal(calls, 1);
  clock += 1;
  assert.equal((await provider.fetchUsage({}, {}))?.limits.length, 4);
  assert.equal(calls, 2);
});

test("provider returns null when the snapshot is missing", async () => {
  const provider = createQuotaUsageProvider({ loadSnapshot: async () => undefined });
  assert.equal(await provider.fetchUsage({}, {}), null);
});

test("provider returns null and logs debug instead of throwing on a failed read", async () => {
  const messages: Array<{ message: string; details: unknown }> = [];
  const provider = createQuotaUsageProvider({
    loadSnapshot: async () => {
      throw new Error("quota read failed");
    },
  });
  const report = await provider.fetchUsage({}, {
    logger: { debug: (message, details) => messages.push({ message, details }) },
  });
  assert.equal(report, null);
  assert.deepEqual(messages, [
    { message: "Antigravity quota unavailable", details: { error: "quota read failed" } },
  ]);
});

test("empty groups produce no limits and fetchUsage returns null", async () => {
  const empty: AntigravityQuotaSnapshot = { at: AT, groups: [] };
  assert.deepEqual(quotaSnapshotToUsageReport(empty).limits, []);
  const provider = createQuotaUsageProvider({ loadSnapshot: async () => empty });
  assert.equal(await provider.fetchUsage({}, {}), null);
});

test("one cancelled subscriber does not disrupt the remaining quota reader", async () => {
  for (const cancelledIndex of [0, 1]) {
    const firstController = new AbortController();
    const secondController = new AbortController();
    const pending = Promise.withResolvers<AntigravityQuotaSnapshot>();
    let sharedSignal: AbortSignal | undefined;
    let loads = 0;
    const provider = createQuotaUsageProvider({
      loadSnapshot: signal => {
        loads++;
        sharedSignal = signal;
        signal?.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
        return pending.promise;
      },
    });
    const requests = [
      provider.fetchUsage({ signal: firstController.signal }, {}),
      provider.fetchUsage({ signal: secondController.signal }, {}),
    ];
    (cancelledIndex === 0 ? firstController : secondController).abort();
    assert.equal(sharedSignal?.aborted, false, "another subscriber still needs the shared operation");
    pending.resolve(snapshot);
    const results = await Promise.allSettled(requests);
    const cancelled = results[cancelledIndex]!;
    const remaining = results[1 - cancelledIndex]!;
    assert.equal(cancelled.status, "rejected");
    assert.equal(cancelled.status === "rejected" && cancelled.reason?.name, "AbortError");
    if (remaining.status !== "fulfilled") throw remaining.reason;
    assert.equal(remaining.value?.limits.length, 4);
    assert.equal(loads, 1, "both subscribers must share one underlying operation");
  }
});

test("the last cancelled subscriber aborts the shared quota request without polluting the cache", async () => {
  const pending = Promise.withResolvers<AntigravityQuotaSnapshot>();
  let sharedSignal: AbortSignal | undefined;
  const provider = createQuotaUsageProvider({
    loadSnapshot: signal => {
      sharedSignal = signal;
      signal?.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
      return pending.promise;
    },
  });
  const first = new AbortController(), second = new AbortController();
  const requests = [
    provider.fetchUsage({ signal: first.signal }, {}),
    provider.fetchUsage({ signal: second.signal }, {}),
  ];
  first.abort();
  assert.equal(sharedSignal?.aborted, false);
  second.abort();
  assert.equal(sharedSignal?.aborted, true);
  const results = await Promise.allSettled(requests);
  assert.ok(results.every(result => result.status === "rejected" && result.reason?.name === "AbortError"));
  pending.resolve(snapshot);
});
