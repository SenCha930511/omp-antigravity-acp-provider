import { test } from "node:test";
import assert from "node:assert/strict";
import { showAcpUpdate } from "../extension/activity-presentation.ts";
import { loadToolPolicy, saveNativeToolMode, saveDebugToolUpdates } from "../extension/tool-policy.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("debug off hides only ACP tool status notifications", () => {
  for (const sessionUpdate of ["tool_call", "tool_call_update"]) {
    for (const status of ["pending", "in_progress", "completed", "failed"]) {
      const notification = { update: { sessionUpdate, status } };
      assert.equal(showAcpUpdate(notification, false), false);
      assert.equal(showAcpUpdate(notification, true), true);
    }
  }
});

test("real thoughts, answers, plans, usage and mode updates remain visible", () => {
  for (const sessionUpdate of ["agent_thought_chunk", "agent_message_chunk", "plan", "usage_update", "config_option_update", "current_mode_update"]) {
    const notification = { update: { sessionUpdate, content: { type: "text", text: "[Antigravity tool update: quoted text]" } } };
    assert.equal(showAcpUpdate(notification, false), true);
  }
});

test("debug defaults off, persists independently, and survives native-tool mode changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-debug-policy-"));
  const file = path.join(root, "omp-tools.json");
  try {
    assert.deepEqual(loadToolPolicy(file), { nativeTools: "disabled", debugToolUpdates: false });
    fs.writeFileSync(file, '{"nativeTools":"disabled"}');
    assert.equal(loadToolPolicy(file).debugToolUpdates, false);
    saveDebugToolUpdates(file, true);
    assert.deepEqual(loadToolPolicy(file), { nativeTools: "disabled", debugToolUpdates: true });
    saveNativeToolMode(file, "prefer");
    assert.equal(loadToolPolicy(file).debugToolUpdates, true);
    saveDebugToolUpdates(file, false);
    assert.deepEqual(loadToolPolicy(file), { nativeTools: "prefer", debugToolUpdates: false });
    for (const text of ['{"nativeTools":null}', '{"debugToolUpdates":"false"}', 'null', '[]']) {
      fs.writeFileSync(file, text);
      assert.throws(() => loadToolPolicy(file), /Invalid OMP ACP tool policy/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
