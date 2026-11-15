import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureLeanAgentWorkspace,
  leanAgentDefinition,
  leanAgentEligible,
  LEAN_AGENT_MIN_CLI_VERSION,
  LEAN_AGENT_NAME,
} from "../extension/lean-agent.ts";
import { compareVersions } from "../extension/runtime/launch.ts";

test("the lean agent definition excludes agy's default components", () => {
  const definition = leanAgentDefinition();
  assert.match(definition, new RegExp(`^---\\nname: ${LEAN_AGENT_NAME}\\n`));
  for (const key of ["tools: []", "inheritMcp: false", "inheritCustomizations: false", "excludeDefaultComponents: true"]) {
    assert.ok(definition.includes(key), `frontmatter must carry ${key}`);
  }
  assert.match(definition, /Use only the provided tools\./);
});

test("the lean agent workspace is created idempotently under the state dir", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lean-agent-test-"));
  try {
    const first = ensureLeanAgentWorkspace(stateDir);
    const file = path.join(first, ".agents", "agents", LEAN_AGENT_NAME, "agent.md");
    assert.equal(fs.readFileSync(file, "utf8"), leanAgentDefinition());
    const second = ensureLeanAgentWorkspace(stateDir);
    assert.equal(second, first);
    assert.equal(fs.readFileSync(file, "utf8"), leanAgentDefinition());
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("lean agent eligibility requires the CLI channel and a modern version", () => {
  assert.equal(leanAgentEligible({ source: "cli", cliVersion: "1.5.9" }, compareVersions), true);
  assert.equal(leanAgentEligible({ source: "cli", cliVersion: LEAN_AGENT_MIN_CLI_VERSION }, compareVersions), true);
  assert.equal(leanAgentEligible({ source: "cli", cliVersion: "1.4.12" }, compareVersions), false);
  assert.equal(leanAgentEligible({ source: "managed", cliVersion: "1.5.9" }, compareVersions), false);
  assert.equal(leanAgentEligible({ source: "cli" }, compareVersions), false);
  assert.equal(leanAgentEligible({ source: "env", cliVersion: "1.5.9" }, compareVersions), false);
});
