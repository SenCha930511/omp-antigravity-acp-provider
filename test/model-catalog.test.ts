import { test } from "node:test";
import assert from "node:assert/strict";
import { projectCatalog, readModels, thoughtRoute, parseThoughtRoute, selectRuntimeModel } from "../extension/model-catalog.ts";
import { advertisedRecord, choices, resolveSelection } from "../extension/selectors.ts";

const state = (models: string[], levels = ["low", "medium", "high"]) => ({ configOptions: [
  { id: "model", category: "model", type: "select", currentValue: models[0], options: models.map(value => ({ value, name: value })) },
  { id: "thinking_level", category: "thought_level", type: "select", currentValue: levels[0], options: levels.map(value => ({ value, name: value })) },
] });

test("catalog includes Gemini, Claude, GPT-OSS and future server IDs", () => {
  const ids = ["gemini-4-argon", "claude-sonnet-5-5", "gpt-oss-120b", "future-vendor/model"];
  assert.deepEqual(projectCatalog(ids.map(modelId => ({ modelId, name: modelId, selector: true }))).map(m => m.id), ids);
});

test("legacy effort groups work for every vendor and preserve exact server IDs", () => {
  const model = projectCatalog(["low", "high", "max"].map(effort => ({ modelId: `claude-opus-5-5-${effort}`, name: `Claude Opus (${effort})` })))[0];
  assert.equal(model.id, "claude-opus-5-5");
  assert.deepEqual(model.thinking.efforts, ["low", "high", "max"]);
  assert.equal(selectRuntimeModel(model, "max").thinkingLevelMap.high, "claude-opus-5-5-max");
});

test("single legacy tier retains its exact ID without inventing more tiers", () => {
  const models = projectCatalog([{ modelId: "some-model-high", name: "Some Model (high)" }]);
  assert.equal(models[0].id, "some-model-high");
  assert.deepEqual(models[0].thinking.efforts, ["high"]);
});

test("a legacy base entry does not hide its advertised effort variants", () => {
  const records = ["custom", "custom-low", "custom-high"].map(modelId => ({ modelId, name: modelId }));
  const models = projectCatalog(records);
  assert.equal(models.length, 1);
  assert.deepEqual(models[0].thinking.efforts, ["low", "high"]);
});

test("new selector routes are local and preserve all recognized reasoning levels", () => {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const model = projectCatalog([{ modelId: "future-model", name: "Future", selector: true, thoughtLevels: levels, defaultThoughtLevel: "max" }])[0];
  for (const effort of levels) {
    const runtime = selectRuntimeModel(model, effort);
    assert.deepEqual(parseThoughtRoute(runtime.thinkingLevelMap.high), { modelId: "future-model", effort });
    assert.equal(runtime.id, "future-model");
  }
  assert.equal(parseThoughtRoute(selectRuntimeModel(model, "auto").thinkingLevelMap.low)?.effort, "max");
});

test("per-model configuration does not leak reasoning tiers to another model", () => {
  const first = advertisedRecord(state(["one"], ["low", "high"]), "one", "One");
  const second = advertisedRecord({ configOptions: [state(["two"]).configOptions[0]] }, "two", "Two");
  const models = projectCatalog([first, second]);
  assert.deepEqual(models[0].thinking.efforts, ["low", "high"]);
  assert.equal(models[1].reasoning, false);
});

test("unknown labels retain a usable model without fictional OMP effort choices", () => {
  const model = projectCatalog([{ modelId: "custom", name: "Custom", selector: true, thoughtLevels: ["turbo"] }])[0];
  assert.equal(model.id, "custom");
  assert.equal(model.reasoning, false);
});

test("unknown limits and prices use conservative metadata without copying Gemini specifications", () => {
  const [known, gemini25, geminiProAgent, unknown] = projectCatalog(
    ["gemini-4-argon", "gemini-2.5-pro", "gemini-pro-agent", "claude-example"].map(modelId => ({ modelId, name: modelId, selector: true })),
  );
  assert.equal(known.contextWindow, 1_000_000);
  assert.equal(gemini25.contextWindow, 1_000_000);
  assert.equal(geminiProAgent.contextWindow, 1_000_000);
  assert.equal(unknown.contextWindow, 32_768);
  assert.equal(unknown.maxTokens, 8192);
  assert.equal(unknown.cost.input, 0);
});

test("unversioned or older Gemini aliases keep conservative limits", () => {
  const models = projectCatalog(["gemini-pro", "gemini-flash", "gemini-exp", "gemini-2.0-flash", "gemini-1.5-pro"]
    .map(modelId => ({ modelId, name: modelId, selector: true })));
  for (const model of models) {
    assert.equal(model.contextWindow, 32_768, `${model.id} must not claim a 1M window without a known version`);
    assert.equal(model.maxTokens, 8192);
  }
});

test("cache validation accepts all vendors and rejects malformed data", () => {
  assert.equal(readModels([{ modelId: "claude/x", name: "Claude" }]).length, 1);
  assert.equal(readModels([{ modelId: "bad\nmodel", name: "Bad" }]).length, 0);
  assert.equal(readModels([{ modelId: "x", name: "X", thoughtLevels: [null] }]).length, 0);
});

test("grouped server selectors are flattened using their exact values", () => {
  assert.deepEqual(choices({ options: [{ group: "claude", options: [{ value: "claude-a", name: "Claude A" }] }] }), [{ value: "claude-a", name: "Claude A" }]);
});

test("an exact model ID takes precedence over a tier-like suffix", () => {
  assert.deepEqual(resolveSelection(state(["claude-high", "claude"]), "claude-high"), { modelId: "claude-high" });
});

test("legacy compatibility translates only when the base is actually advertised", () => {
  assert.deepEqual(resolveSelection(state(["claude"]), "claude-high"), { modelId: "claude", effort: "high" });
  assert.deepEqual(resolveSelection(state(["other"]), "claude-high"), { modelId: "claude-high" });
});

test("local routes reject removed models and malformed payloads", () => {
  assert.throws(() => resolveSelection(state(["other"]), thoughtRoute("removed", "high")), /no longer advertises/);
  assert.throws(() => parseThoughtRoute("__omp_acp_thought__:bad-data"), /Invalid local/);
  assert.deepEqual(resolveSelection(state(["claude"]), thoughtRoute("claude", "max")), { modelId: "claude", effort: "max" });
});
