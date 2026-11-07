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
