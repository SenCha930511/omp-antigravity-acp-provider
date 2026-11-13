import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AntigravityRuntime } from "../extension/runtime.mjs";

test("CLI quota uses the selected CLI without creating an ACP connection", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cli-quota-"));
  const cli = path.join(directory, "agy");
  const argsFile = path.join(directory, "args");
  fs.writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf 'Gemini Models\\tWeekly Limit Remaining\\t40%%\\t2026-11-14T13:50:05Z\\n'\n`);
  fs.chmodSync(cli, 0o755);
  const runtime = new AntigravityRuntime(() => {
    throw new Error("ACP connection must not be created for CLI quota");
  }, "yolo");
  (runtime as { ompQuotaCliPath?: string }).ompQuotaCliPath = cli;
  try {
    const snapshot = await runtime.quota(undefined);
    assert.deepEqual(snapshot.groups, [{
      displayName: "Gemini Models",
      buckets: [{ window: "weekly", remainingFraction: 0.4, resetTime: "2026-11-14T13:50:05.000Z" }],
    }]);
    assert.deepEqual(fs.readFileSync(argsFile, "utf8").trim().split("\n"), ["--app_data_dir=antigravity-acp", "-p", "/usage"]);
  } finally {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
