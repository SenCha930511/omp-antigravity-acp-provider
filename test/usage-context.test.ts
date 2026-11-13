import { test } from "node:test";
import assert from "node:assert/strict";
import { usageFromPrompt } from "../extension/usage.ts";
import { estimateContextTokens } from "../extension/runtime/prompt.ts";
import { stableTools } from "../extension/tool-order.ts";

test("OMP receives context occupancy separately from multi-call billable usage", () => {
  const usage = usageFromPrompt({ usage: { inputTokens: 36_554, outputTokens: 613 }, _meta: { ompContextTokens: 12_695 } });
  assert.equal(usage.totalTokens, 37167);
  assert.equal(usage.contextTokens, 12695);
  assert.equal(usage.contextTokensSource, "server");
  assert.equal(usageFromPrompt({ _meta: { ompContextTokens: -1 } }).contextTokens, undefined);
});

test("cumulative billing never masquerades as context occupancy", () => {
  const usage = usageFromPrompt(
    { usage: { inputTokens: 0, cachedReadTokens: 2_888_743, outputTokens: 14_778 } },
    104_321,
  );
  assert.equal(usage.cacheRead, 2_888_743, "billable cache reads must remain intact");
  assert.equal(usage.totalTokens, 2_903_521, "aggregate billable usage must remain intact");
  assert.equal(usage.contextTokens, 104_321);
  assert.equal(usage.contextTokensSource, "estimate");
});

test("server occupancy wins and an invalid server value falls back", () => {
  const server = usageFromPrompt({ usage: { inputTokens: 100, outputTokens: 10 }, _meta: { ompContextTokens: 12_695 } }, 104_321);
  assert.equal(server.contextTokens, 12_695);
  assert.equal(server.contextTokensSource, "server");
  const invalid = usageFromPrompt({ usage: { inputTokens: 100, outputTokens: 10 }, _meta: { ompContextTokens: -1 } }, 104_321);
  assert.equal(invalid.contextTokens, 104_321);
  assert.equal(invalid.contextTokensSource, "estimate");
});

test("a small OMP history cannot inherit a huge cumulative cacheRead", () => {
  const estimate = estimateContextTokens({
    systemPrompt: "small fixture policy",
    messages: [{ role: "user", content: "hello" }],
  });
  const usage = usageFromPrompt(
    { usage: { inputTokens: 0, cachedReadTokens: 2_888_743, outputTokens: 14_778 } },
    estimate,
  );
  assert.ok(estimate > 0 && estimate < 100, `small history estimate: ${estimate}`);
  assert.equal(usage.contextTokens, estimate);
  assert.equal(usage.contextTokensSource, "estimate");
  assert.equal(usage.cacheRead, 2_888_743);
  assert.ok(usage.contextTokens! < usage.cacheRead / 10_000);
});

test("tool projection preserves caller order and function identities", () => {
  const read = { name: "read", execute() {} }, bash = { name: "bash", execute() {} };
  const original = [read, bash];
  assert.deepEqual(stableTools(original).map(tool => tool.name), ["read", "bash"]);
  assert.deepEqual(stableTools([bash, read]).map(tool => tool.name), ["bash", "read"]);
  assert.equal(stableTools(original)[0], read);
  assert.equal(stableTools(original)[1], bash);
  assert.equal(original[0], read);
});
