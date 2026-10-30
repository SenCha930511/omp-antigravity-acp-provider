import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { estimateTransferTokens, loadContextSettings, resolveContextOptions, saveContextSettings, updateContextSettings } from "../extension/context-settings.ts";

test("NCHC-sized client window leaves enough token budget for OMP to compact at 85%", () => {
  const model = { id: "gemini-3.8-flash", contextWindow: 1_000_000, maxTokens: 65536 };
  const settings = { defaults: { contextWindow: 524288, maxTokens: 32000, usageMode: "off" as const }, models: {} };
  const options = resolveContextOptions(model, settings);
  assert.equal(options.contextWindow, 524288); assert.equal(options.maxTokens, 32000);
  assert.equal(Math.floor(options.contextWindow * .85), 445644);
  assert.ok(options.inputTokenBudget > 445644);
  assert.equal(options.maxTransferBytes, 16777216);
});
test("per-model options and usage preference persist independently without mutating defaults", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-context-settings-"));
  try {
    const file = path.join(root, "context.json");
    let settings = loadContextSettings(file);
    settings = updateContextSettings(settings, "default", "maxTransferBytes", 33554432);
    settings = updateContextSettings(settings, "default", "usageMode", "off");
    settings = updateContextSettings(settings, "gemini-3.8-flash", "contextWindow", 524288);
    saveContextSettings(file, settings);
    assert.deepEqual(loadContextSettings(file), settings);
    assert.equal(settings.defaults.contextWindow, undefined);
    assert.equal(resolveContextOptions({ id: "other", contextWindow: 1_000_000, maxTokens: 65536 }, settings).contextWindow, 1_000_000);
    assert.throws(() => updateContextSettings(settings, "default", "maxTransferBytes", "bad"), /Invalid/);
    assert.throws(() => updateContextSettings(settings, "__proto__", "contextWindow", 8192), /Invalid/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("invalid token combinations are rejected rather than silently changing the advertised window", () => {
  assert.throws(() => resolveContextOptions({ id: "x", contextWindow: 32768, maxTokens: 8192 }, { defaults: { inputTokenBudget: 100000 }, models: {} }), /must fit/);
  assert.ok(estimateTransferTokens("中文".repeat(100)) > estimateTransferTokens("aa".repeat(100)));
});

test("setting validation rejects inherited keys and model names never mutate inherited functions", () => {
  for (const key of ["constructor", "toString", "hasOwnProperty"]) {
    assert.throws(() => updateContextSettings({ defaults: {}, models: {} }, "default", key, 12345), /Invalid/);
  }
  const method = Object.prototype.toString;
  const before = Object.getOwnPropertyDescriptor(method, "contextWindow");
  try {
    const next = updateContextSettings({ defaults: {}, models: {} }, "toString", "contextWindow", 65536);
    assert.ok(Object.hasOwn(next.models, "toString"));
    assert.deepEqual(next.models.toString, { contextWindow: 65536 });
    assert.deepEqual(Object.getOwnPropertyDescriptor(method, "contextWindow"), before);
  } finally {
    if (before) Object.defineProperty(method, "contextWindow", before);
    else Reflect.deleteProperty(method, "contextWindow");
  }
});
