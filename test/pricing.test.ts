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
