// Optional integration with a local OMP source checkout; no model inference.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mock } from "bun:test";
import { buildPromptParts } from "../extension/context-transfer.ts";

const source = process.env.OMP_ACP_TEST_OMP_SOURCE;
if (!source) throw new Error("Set OMP_ACP_TEST_OMP_SOURCE to an OMP source checkout");
const nativeAddon = process.env.OMP_ACP_TEST_NATIVE_ADDON;
if (nativeAddon) {
  // A source checkout may lack its built addon. The optional installed addon
  // is injected in this test process only; source/configuration stay untouched.
  const natives = createRequire(import.meta.url)(path.resolve(nativeAddon));
  const loaderPath = path.join(source, "packages/natives/native/loader-state.js");
  const loader = await import(pathToFileURL(loaderPath).href);
  mock.module(loaderPath, () => ({ ...loader, loadNative: () => natives }));
}
const { generateSummary } = await import(pathToFileURL(path.join(source, "packages/agent/src/compaction/compaction.ts")).href);
const AIError = await import(pathToFileURL(path.join(source, "packages/ai/src/error/index.ts")).href);
const model = { id: "gemini-3.8-flash", name: "Offline ACP compaction", api: "antigravity-acp", provider: "antigravity-acp",
  contextWindow: 524288, maxTokens: 32000, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const history = Array.from({ length: 60 }, (_, index) => ({ role: "user" as const,
  content: `PART_${index}_BEGIN ` + "synthetic source history ".repeat(500) + ` PART_${index}_END`, timestamp: index }));
let rejected = 0, accepted = 0;
const seen = new Set<number>();
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const summary = await generateSummary(history, model, 4096, "offline-fixture", undefined, undefined, undefined, {
  oneshotRetry: false,
  completeImpl: async (_model: unknown, context: any) => {
    // Match the adapter wrapper's string system-prompt boundary.
    const routed = { ...context,
      systemPrompt: Array.isArray(context.systemPrompt) ? context.systemPrompt.join("\n\n") : context.systemPrompt };
    try { buildPromptParts(routed, true, undefined, { contextWindow: model.contextWindow }); }
    catch (error) {
      rejected++;
      const message = (error as Error).message;
      assert.ok(AIError.is(AIError.classify(message), AIError.Flag.ContextOverflow), message);
      return { role: "assistant", content: [], model: model.id, provider: model.provider, api: model.api,
        timestamp: 1, stopReason: "error", errorMessage: message, usage };
    }
    accepted++;
    const text = JSON.stringify(context.messages);
    for (let index = 0; index < history.length; index++) if (text.includes(`PART_${index}_BEGIN`)) seen.add(index);
    return { role: "assistant", content: [{ type: "text", text: "Compacted decisions: Magpie; named tunnel; fixed upstream key." }],
      model: model.id, provider: model.provider, api: model.api, timestamp: 1, stopReason: "stop", usage };
  },
});
assert.ok(rejected > 0, "The first large summary window must hit the real adapter guard");
assert.ok(accepted > 1, "OMP must shrink and split into multiple accepted summary windows");
assert.equal(seen.size, history.length, "Accepted windows must cover the complete synthetic history");
assert.match(summary, /Magpie; named tunnel; fixed upstream key/);
const refined = buildPromptParts({ messages: [{ role: "user", content: summary },
  { role: "user", content: "EXPLAIN_THE_APPROVED_ARCHITECTURE" }] }, true, undefined, { contextWindow: model.contextWindow });
assert.equal(refined.prompt.at(-1)?.text, "EXPLAIN_THE_APPROVED_ARCHITECTURE");
console.log(JSON.stringify({ rejectedWindows: rejected, acceptedWindows: accepted, coveredMessages: seen.size,
  newestRequestPreserved: true, inferenceCalls: 0 }));
