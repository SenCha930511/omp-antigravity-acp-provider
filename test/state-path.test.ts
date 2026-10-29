import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveAdapterStateDir } from "../extension/index.ts";

test("adapter state follows the active OMP agent directory and custom config root", () => {
  const home = path.resolve("/synthetic-home");
  const suffix = "antigravity-acp-provider";
  assert.equal(resolveAdapterStateDir({}, home), path.join(home, ".omp/agent", suffix));
  assert.equal(resolveAdapterStateDir({ PI_CONFIG_DIR: ".custom" }, home), path.join(home, ".custom/agent", suffix));
  assert.equal(resolveAdapterStateDir({ PI_CODING_AGENT_DIR: path.join(home, ".omp/profiles/work/agent") }, home), path.join(home, ".omp/profiles/work/agent", suffix));
  assert.equal(resolveAdapterStateDir({ PI_CODING_AGENT_DIR: "~/custom-agent" }, home), path.join(home, "custom-agent", suffix));
});
