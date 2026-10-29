// Offline control-flow regression. No constructor, process or authentication.
import assert from "node:assert/strict";
import { AntigravityAcpConnection } from "../extension/vendor/pi-antigravity-acp-provider/src/acp/connection.ts";
import { TierConnection } from "../extension/tier-connection.ts";
const original = AntigravityAcpConnection.prototype.prompt;
const zero = { input: 0, completion: 0, thinking: 0, cached: 0, total: 0 };
let report = "**Session total:** 120 tokens (prompt: 100, completion: 10, thinking: 10)";
let queries = 0, modelCalls = 0, fail = false;
AntigravityAcpConnection.prototype.prompt = async function(request: any) {
  if (request.prompt[0].text === "/usage") {
    queries++;
    if (fail) throw new Error("quota service unavailable");
    (this as any).usageCapture.text = report;
  } else modelCalls++;
  return { stopReason: "end_turn" };
};
function fixture(baseline: any = zero, advertised = true) {
  return Object.assign(Object.create(TierConnection.prototype), {
    activePrompts: 0, usageQueryCount: 0, usageQueryMs: 0,
    contextUsage: new Map([["session", { used: 75, size: 1000 }]]), usageStatus: new Map(),
    usageBaselines: new Map(baseline ? [["session", baseline]] : []),
    usageCommands: new Set(advertised ? ["session"] : []),
  });
}
const request: any = { sessionId: "session", prompt: [{ type: "text", text: "normal" }] };
try {
  const connection = fixture();
  const first = await connection.prompt(request);
  assert.equal(first.usage.inputTokens, 100);
  assert.equal(first.usage.outputTokens, 20);
  assert.equal(first._meta.ompContextTokens, 75);
  report = "**Session total:** 180 tokens (prompt: 150, completion: 15, thinking: 15)";
  const second = await connection.prompt(request);
  assert.equal(second.usage.inputTokens, 50);
  assert.equal(second.usage.outputTokens, 10);
  report = "**Session total:** 12 tokens (prompt: 10, completion: 2)";
  assert.equal((await connection.prompt(request)).usage, undefined, "Counter reset must not create negative billing");
  fail = true;
  assert.equal((await connection.prompt(request)).stopReason, "end_turn", "Usage failure must preserve model success");
  assert.equal(connection.activePrompts, 0);
  assert.equal(connection.usageBaselines.size, 0, "A failed query must not charge a gap to a future turn");
  const before = queries;
  await fixture(zero, false).prompt(request);
  assert.equal(queries, before, "Never send an unadvertised slash command to the model");
  const disabled = fixture();
  disabled.configureUsage("off");
  const withoutQuery = await disabled.prompt(request);
  assert.equal(queries, before, "Per-plugin off mode must skip supplemental queries");
  assert.equal(withoutQuery._meta.ompContextTokens, 75, "Off mode must preserve context occupancy for auto-compaction");
  fail = false;
  const restored = fixture(undefined);
  // Explicitly clear the baseline; /usage snapshots before and after are equal.
  restored.usageBaselines.clear();
  const result = await restored.prompt(request);
  assert.equal(result.usage.inputTokens, 0, "Restored history must not be billed again");
  assert.ok(modelCalls >= 6);
  console.log("Usage queries, restore baseline, resets, failures and advertised-command gating: PASS");
} finally { AntigravityAcpConnection.prototype.prompt = original; }
