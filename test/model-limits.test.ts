import { test } from "node:test";
import assert from "node:assert/strict";
import { FALLBACK_MODELS, KNOWN_MODEL_LIMITS, modelLimits, projectModels } from "../extension/runtime/models.ts";

function limitsOf(id: string, name = id) {
  const [model] = projectModels([{ modelId: id, name }]);
  assert.ok(model, `expected a projected model for ${id}`);
  return { contextWindow: model.contextWindow, maxTokens: model.maxTokens };
}

test("known non-gemini partner models resolve their catalog limits", () => {
  assert.deepEqual(limitsOf("gpt-oss-120b-medium"), { contextWindow: 131_072, maxTokens: 32_768 });
  assert.deepEqual(limitsOf("claude-opus-4-6-thinking"), { contextWindow: 250_000, maxTokens: 64_000 });
  assert.deepEqual(limitsOf("claude-sonnet-4-6"), { contextWindow: 250_000, maxTokens: 64_000 });
});

test("effort-suffixed ids resolve to their base model limits", () => {
  assert.deepEqual(limitsOf("gemini-4-argon-high"), { contextWindow: 1_048_576, maxTokens: 65_536 });
  assert.deepEqual(limitsOf("gemini-3.1-flash-image-high"), { contextWindow: 65_536, maxTokens: 65_536 });
});

test("grouped effort variants collapse to the canonical base id and its limits", () => {
  const models = projectModels(["low", "medium", "high"].map((effort) => ({
    modelId: `gemini-4-carbon-${effort}`,
    name: `Gemini 4 Carbon (${effort})`,
  })));
  assert.equal(models.length, 1);
  assert.equal(models[0]!.id, "gemini-4-carbon");
  assert.deepEqual(
    { contextWindow: models[0]!.contextWindow, maxTokens: models[0]!.maxTokens },
    { contextWindow: 1_048_576, maxTokens: 262_144 },
  );
});

test("unknown ids keep the generic default limits", () => {
  assert.deepEqual(limitsOf("future-model-x"), { contextWindow: 1_000_000, maxTokens: 65_536 });
  assert.deepEqual(limitsOf("gemini-3.7-flash"), { contextWindow: 1_000_000, maxTokens: 65_536 });
});

test("fallback models pick up limits where the catalog knows them", () => {
  const flash = FALLBACK_MODELS.find((model) => model.id === "gemini-3.8-flash");
  assert.ok(flash);
  assert.deepEqual(
    { contextWindow: flash.contextWindow, maxTokens: flash.maxTokens },
    KNOWN_MODEL_LIMITS["gemini-3.8-flash"]!,
  );
});

test("alias and extended-effort ids resolve the same limits as the catalog", () => {
  assert.deepEqual(modelLimits("models/gpt-oss-120b"), { contextWindow: 131_072, maxTokens: 32_768 });
  assert.deepEqual(modelLimits("models/claude-opus-4-6"), { contextWindow: 250_000, maxTokens: 64_000 });
  assert.deepEqual(modelLimits("claude-opus-4-6-max"), { contextWindow: 250_000, maxTokens: 64_000 });
  assert.deepEqual(modelLimits("gemini-4-carbon-max"), { contextWindow: 1_048_576, maxTokens: 262_144 });
  assert.deepEqual(modelLimits("gemini-3.1-flash-image-high"), { contextWindow: 65_536, maxTokens: 65_536 });
});
