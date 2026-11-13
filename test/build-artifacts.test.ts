import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const bundle = path.resolve("extension/runtime.mjs");
const built = fs.existsSync(bundle);

test("built writer classifies quota failures before OMP decides to retry", { skip: !built }, async () => {
  const { PiEventWriter } = await import("../extension/runtime.mjs");
  const writer = new PiEventWriter({ api: "acp", provider: "antigravity-acp", id: "test" });
  writer.fail(new Error("You exceeded your monthly limit"));
  const events: any[] = [];
  for await (const event of writer.stream) events.push(event);
  const failure = events.find(event => event.type === "error");
  assert.match(failure.error.errorMessage, /quota exceeded/);
});

test("built MCP bridge disables Node server timeouts", { skip: !built }, () => {
  const text = fs.readFileSync(bundle, "utf8");
  assert.match(text, /this\.server\.keepAliveTimeout = 0;/);
  assert.match(text, /this\.server\.requestTimeout = 0;/);
  assert.match(text, /this\.server\.headersTimeout = 0;/);
});

test("built runtime passes the full-context estimate to the final usage projection", { skip: !built }, () => {
  const text = fs.readFileSync(bundle, "utf8");
  assert.match(text, /usageFromPrompt2\(response, binding\.ompFallbackContextTokens\)/,
    "the final response must receive the full OMP context estimate");
});

test("built supervisor launches adapter-generated Windows wrappers", { skip: !built }, () => {
  const text = fs.readFileSync(path.resolve("extension/assets/src/acp/supervisor.mjs"), "utf8");
  assert.ok(text.includes('const windowsBatch = process.platform === "win32" && /\\.(?:cmd|bat)$/iu.test(agentCommand);'));
  assert.ok(text.includes("windowsVerbatimArguments: true"));
});
