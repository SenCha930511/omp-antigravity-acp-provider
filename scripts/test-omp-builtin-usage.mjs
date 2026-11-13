import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform === "win32") {
  console.log("Built-in OMP usage probe requires a POSIX CLI fixture: SKIPPED");
  process.exit(0);
}
const requestedOmp = process.env.OMP_ACP_TEST_OMP_BIN ?? "omp";
const omp = fs.realpathSync(path.isAbsolute(requestedOmp) ? requestedOmp : execFileSync("which", [requestedOmp], { encoding: "utf8" }).trim());
const version = execFileSync(omp, ["--version"], { encoding: "utf8" }).trim();

function fixture(prefix) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const bin = path.join(home, "bin");
  const state = path.join(home, "agent", "antigravity-acp-provider");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  // Keep the host launcher runnable without exposing the real agy CLI.
  fs.symlinkSync(fs.realpathSync(execFileSync("which", ["bun"], { encoding: "utf8" }).trim()), path.join(bin, "bun"));
  return { home, bin, state };
}

function usage(home, commandPath) {
  const env = {
    ...process.env,
    HOME: home,
    GEMINI_API_KEY: "offline-fixture",
    PI_CODING_AGENT_DIR: path.join(home, "agent"),
    GEMINI_HOME: path.join(home, "gemini"),
    PATH: commandPath,
  };
  delete env.AGY_ACP_BIN;
  const result = spawnSync(omp, ["usage", "--provider", "antigravity-acp", "--no-extensions", "-e", path.join(root, "extension/index.ts"), "--json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

const cliFixture = fixture("omp-builtin-cli-");
const emptyFixture = fixture("omp-builtin-empty-");
try {
  const callsFile = path.join(cliFixture.home, "calls.jsonl");
  const cli = path.join(cliFixture.bin, "agy");
  fs.writeFileSync(cli, `#!/bin/sh
printf '%s\\n' "$@" >> '${callsFile}'
if [ "$1" = "acp" ] && [ "$2" = "--version" ]; then
  printf '1.5.3\\n'
  exit 0
fi
if [ "$1" = "--app_data_dir=antigravity-acp" ] && [ "$2" = "-p" ] && [ "$3" = "/usage" ]; then
  printf 'Gemini Models\\tFive Hour Limit Remaining\\t83%%\\n'
  printf 'Gemini 4 Argon\\tWeekly Limit Remaining\\t47%%\\t2026-11-14T13:50:05.123456789Z\\n'
  exit 0
fi
exit 99
`);
  fs.chmodSync(cli, 0o755);
  const report = usage(cliFixture.home, cliFixture.bin);
  assert.equal(report.reports.length, 1);
  assert.equal(report.reports[0].provider, "antigravity-acp");
  const limits = report.reports[0].limits;
  assert.ok(Array.isArray(limits));
  const fiveHour = limits.filter(limit => limit.scope?.tier === "Gemini Models");
  assert.ok(fiveHour.length > 1, "the shared family must retain individual model scopes");
  assert.ok(fiveHour.every(limit => typeof limit.scope.modelId === "string" && limit.scope.modelId.startsWith("gemini-")));
  assert.ok(fiveHour.some(limit => limit.scope.modelId === "gemini-3.8-flash"));
  assert.ok(fiveHour.every(limit => limit.window.id === "5h" && limit.amount.remainingFraction === 0.83));
  const argon = limits.find(limit => limit.scope?.modelId === "gemini-4-argon");
  assert.ok(argon, "single-model Argon quota must be attached to its actual model ID");
  assert.equal(argon.window.id, "7d");
  assert.equal(argon.window.resetsAt, Date.parse("2026-11-14T13:50:05.123Z"));
  assert.equal(argon.amount.remainingFraction, 0.47);
  const calls = fs.readFileSync(callsFile, "utf8").trimEnd().split("\n");
  assert.ok(calls.includes("acp"));
  assert.equal(calls.filter(argument => argument === "/usage").length, 1);
  assert.equal(fs.existsSync(path.join(cliFixture.state, "agy-acp-cli.sh")), false);
  assert.equal(fs.existsSync(path.join(cliFixture.state, "acp-runtime-source.json")), false);

  const empty = usage(emptyFixture.home, emptyFixture.bin);
  assert.deepEqual(empty.reports, []);
  assert.equal(fs.existsSync(path.join(emptyFixture.home, ".local", "opt", "agy-acp", "current", "install-integrity.json")), false);
  console.log(JSON.stringify({ omp: version, scopedModels: fiveHour.length + 1, cliQuotaCalls: calls.filter(argument => argument === "/usage").length, noRuntimeReports: empty.reports.length }));
  console.log("Actual OMP built-in usage provider and no-runtime path: PASS");
} finally {
  fs.rmSync(cliFixture.home, { recursive: true, force: true });
  fs.rmSync(emptyFixture.home, { recursive: true, force: true });
}
