import { test } from "node:test";
import assert from "node:assert/strict";
import { officialApiCost, applyApiCostEstimate } from "../extension/pricing.ts";

test("Argon uses undiscounted list prices for all effort variants", () => {
  for (const id of ["gemini-4-argon", "gemini-4-argon-off", "gemini-4-argon-minimal", "gemini-4-argon-low",
    "gemini-4-argon-medium", "gemini-4-argon-high", "gemini-4-argon-xhigh", "gemini-4-argon-max"]) {
    assert.deepEqual(officialApiCost(id), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 });
  }
});

test("Flash announced price change uses the UTC boundary", () => {
  assert.equal(officialApiCost("gemini-3.8-flash", Date.UTC(2027, 0, 1) - 1)?.input, 0.75);
  assert.equal(officialApiCost("gemini-3.8-flash", Date.UTC(2027, 0, 1))?.input, 1.5);
});

test("newly advertised models resolve to API-equivalent list rates", () => {
  assert.deepEqual(officialApiCost("gemini-4-hydrogen-high"), { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 });
  assert.deepEqual(officialApiCost("models/gemini-4-hydrogen"), { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 });
  assert.deepEqual(officialApiCost("gemini-pro-orchestrator-g1-pro"), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 });
  assert.deepEqual(officialApiCost("claude-opus-5-5-high"), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  assert.deepEqual(officialApiCost("claude-sonnet-5-5"), { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
  assert.deepEqual(officialApiCost("gpt-oss-120b-medium"), { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 });
});

test("cache writes use the model rate when the server reports them", () => {
  const usage: any = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 };
  applyApiCostEstimate("claude-sonnet-5-5", usage);
  assert.deepEqual(usage.cost, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, total: 14.6 });
});

test("cost estimation charges reported cached and uncached input separately", () => {
  const usage: any = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 };
  applyApiCostEstimate("gemini-4-argon", usage);
  assert.deepEqual(usage.cost, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0, total: 24.2 });
});

test("missing token counts do not invent billable usage", () => {
  const usage: any = { input: NaN, output: -5, cacheRead: undefined };
  applyApiCostEstimate("gemini-4-argon", usage);
  assert.equal(usage.cost.total, 0);
  const unknown = { input: 10 };
  applyApiCostEstimate("unknown-model", unknown);
  assert.equal("cost" in unknown, false);
});
