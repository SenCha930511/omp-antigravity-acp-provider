import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessionUsage, usageDelta } from "../extension/usage-accounting.ts";

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
