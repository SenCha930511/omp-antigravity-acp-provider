// Offline command integration test; requires Bun but never launches ACP.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerOmpAdapter } from "../extension/index.ts";
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tool-command-"));
const hooks = new Map<string, Function>();
let command: any;
try {
  await registerOmpAdapter({
    on(name: string, handler: Function) { hooks.set(name, handler); },
    registerProvider() {}, registerTool() {},
    registerCommand(_name: string, registered: any) { command = registered; },
  }, temporary);
  const notices: string[] = [];
  const context = { ui: { notify: (text: string) => notices.push(text) }, sessionManager: { getSessionId: () => "fixture" } };
  await command.handler("cleanup", context);
  assert.match(notices.pop()!, /Mode:\s+conservative/);
  for (const mode of ["off", "conservative", "timeout 3"]) {
    await command.handler(`cleanup ${mode}`, context);
    const saved = JSON.parse(await fs.readFile(path.join(temporary, "cleanup.json"), "utf8"));
    assert.equal(saved.mode, mode.split(" ")[0]);
    notices.pop();
  }
  await command.handler("cleanup budget 4 16", context);
  const budget = JSON.parse(await fs.readFile(path.join(temporary, "cleanup.json"), "utf8"));
  assert.equal(budget.maxSessions, 4); assert.equal(budget.maxBytes, 16 * 1024 * 1024); notices.pop();
  for (const setting of ["on", "reset", "off"]) { await command.handler(`diagnostics ${setting}`, context); notices.pop(); }
  assert.equal(JSON.parse(await fs.readFile(path.join(temporary, "diagnostics.json"), "utf8")).enabled, false);
  await assert.rejects(command.handler("diagnostics invalid", context), /Usage:/);
  assert.equal(JSON.parse(await fs.readFile(path.join(temporary, "cleanup.json"), "utf8")).idleDays, 3);
  for (const invalid of ["typo", "timeout 0", "timeout NaN", "off 7", "timeout 7 extra"]) {
    await assert.rejects(command.handler(`cleanup ${invalid}`, context));
  }
  for (const mode of ["disabled", "prefer"]) {
    await command.handler(`native-tools ${mode}`, context);
    const policy = JSON.parse(await fs.readFile(path.join(temporary, "omp-tools.json"), "utf8"));
    assert.equal(policy.nativeTools, mode);
  }
  await assert.rejects(command.handler("native-tools typo", context), /must be prefer or disabled/);
  assert.equal(JSON.parse(await fs.readFile(path.join(temporary, "omp-tools.json"), "utf8")).nativeTools, "prefer");
  await command.handler("native-tools disabled", context);
  await command.handler("debug on", context);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(temporary, "omp-tools.json"), "utf8")), { nativeTools: "disabled", debugToolUpdates: true });
  await command.handler("debug off", context);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(temporary, "omp-tools.json"), "utf8")), { nativeTools: "disabled", debugToolUpdates: false });
  await assert.rejects(command.handler("debug typo", context), /Usage:/);
  assert.ok(notices.length === 5);
  await command.handler("context set default contextWindow 524288", context);
  await command.handler("context set default maxTokens 32000", context);
  await command.handler("context set default maxTransferBytes 33554432", context);
  await command.handler("usage off", context);
  let contextPolicy = JSON.parse(await fs.readFile(path.join(temporary, "context.json"), "utf8"));
  assert.equal(contextPolicy.defaults.contextWindow, 524288);
  assert.equal(contextPolicy.defaults.maxTokens, 32000);
  assert.equal(contextPolicy.defaults.maxTransferBytes, 33554432);
  assert.equal(contextPolicy.defaults.usageMode, "off");
  await command.handler("usage auto", context);
  contextPolicy = JSON.parse(await fs.readFile(path.join(temporary, "context.json"), "utf8"));
  assert.equal(contextPolicy.defaults.usageMode, "auto");
  assert.equal(contextPolicy.defaults.maxTransferBytes, 33554432);
  await assert.rejects(command.handler("context set default inputTokenBudget 9999999", context), /must fit/);
  await assert.rejects(command.handler("usage typo", context), /Usage:/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(temporary, "omp-tools.json"), "utf8")), { nativeTools: "disabled", debugToolUpdates: false });
  console.log("Isolated native-tool command persistence and validation: PASS");
} finally {
  await hooks.get("session_shutdown")?.({}, {});
  await fs.rm(temporary, { recursive: true, force: true });
}
