// Offline test of the automatic ACP runtime-source choice: a newer agy CLI on
// PATH routes the launch through a generated AGY_ACP_BIN wrapper, while an
// older, broken or missing CLI and an explicit env override keep the managed
// runtime. Everything runs against stub binaries and fixture homes; no
// network, no real agy, no ACP session.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertSelectedAcpCliLaunch, preferNewestAcpRuntime, resolveAcpPermissionProfile } from "../extension/acp-runtime-source.ts";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "acp-runtime-source-"));
const bin = path.join(work, "bin");
const home = path.join(work, "home");
fs.mkdirSync(bin, { recursive: true });

function stubAgy(script: string): void {
  const file = path.join(bin, "agy");
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(file, 0o755);
}

function removeAgy(): void {
  fs.rmSync(path.join(bin, "agy"), { force: true });
}

function setManagedVersion(version: string): void {
  const current = path.join(home, ".local", "opt", "agy-acp", "current");
  fs.mkdirSync(current, { recursive: true });
  fs.writeFileSync(path.join(current, "install-integrity.json"), JSON.stringify({ version }));
}

function freshStateDir(): string {
  const stateDir = path.join(work, `state-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

function freshEnv(): NodeJS.ProcessEnv {
  return { PATH: `${bin}${path.delimiter}/usr/bin:/bin` };
}

// An explicit AGY_ACP_BIN always wins and nothing is written.
{
  const env = freshEnv();
  env.AGY_ACP_BIN = "/opt/custom-agy";
  const stateDir = freshStateDir();
  const preference = await preferNewestAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "env");
  assert.equal(env.AGY_ACP_BIN, "/opt/custom-agy");
  assert.equal(fs.existsSync(path.join(stateDir, "agy-acp-cli.sh")), false);
}

// A newer CLI takes over through a generated executable wrapper and records
// the decision.
{
  const argvRecord = path.join(work, "agy-argv.txt");
  stubAgy(`if [ "$1" = "acp" ] && [ "$2" = "--version" ]; then\n  echo 9.9.9\n  exit 0\nfi\nprintf '%s\\n' "$@" > '${argvRecord}'`);
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const preference = await preferNewestAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "cli");
  assert.equal(preference.cliVersion, "9.9.9");
  assert.equal(preference.managedVersion, "1.4.5");
  const wrapper = path.join(stateDir, "agy-acp-cli.sh");
  assert.equal(env.AGY_ACP_BIN, wrapper);
  const script = fs.readFileSync(wrapper, "utf8");
  assert.ok(script.startsWith("#!/bin/sh\n"));
  assert.ok(script.includes(`exec '${path.join(bin, "agy")}' acp --app_data_dir=antigravity-acp "$@"`));
  fs.accessSync(wrapper, fs.constants.X_OK);
  const record = JSON.parse(fs.readFileSync(path.join(stateDir, "acp-runtime-source.json"), "utf8"));
  assert.equal(record.source, "cli");
  assert.equal(record.cliVersion, "9.9.9");
  const repeated = await preferNewestAcpRuntime(stateDir, env, home);
  assert.equal(repeated.source, "cli");
  assert.equal(repeated.cliVersion, "9.9.9");
  assert.equal(repeated.managedVersion, "1.4.5");
  assert.equal(resolveAcpPermissionProfile(repeated, "yolo").wireMode, "default");
  assert.equal(resolveAcpPermissionProfile(repeated, "yolo").autoApproveProcess, true);

  for (const marker of ["1", undefined, ""]) {
    const childEnv = freshEnv();
    if (marker !== undefined) childEnv.OMP_ACP_DANGEROUSLY_SKIP_PERMISSIONS = marker;
    fs.rmSync(argvRecord, { force: true });
    const result = spawnSync(wrapper, ["--fixture-argument"], { env: childEnv, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const argv = fs.readFileSync(argvRecord, "utf8").trimEnd().split("\n");
    assert.equal(argv.filter(value => value === "--dangerously-skip-permissions").length, marker === "1" ? 1 : 0,
      `dangerous flag count with marker ${JSON.stringify(marker)}`);
    assert.deepEqual(argv.slice(0, 2), ["acp", "--app_data_dir=antigravity-acp"]);
    assert.equal(argv.at(-1), "--fixture-argument");
  }
  assert.doesNotThrow(() => assertSelectedAcpCliLaunch(stateDir, preference, env));
  assert.throws(() => assertSelectedAcpCliLaunch(stateDir, preference, { ...env, AGY_ACP_BIN: "/usr/bin/false" }), /not selected by AGY_ACP_BIN/);
  fs.writeFileSync(wrapper, "#!/bin/sh\nexit 0\n");
  assert.throws(() => assertSelectedAcpCliLaunch(stateDir, preference, env), /changed/);
  fs.rmSync(wrapper);
  assert.throws(() => assertSelectedAcpCliLaunch(stateDir, preference, env), /wrapper is missing, changed, not executable/);
}

// A record-write failure must abort CLI selection before AGY_ACP_BIN is set.
{
  stubAgy("echo 9.9.9");
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  fs.mkdirSync(path.join(stateDir, "acp-runtime-source.json"));
  await assert.rejects(preferNewestAcpRuntime(stateDir, env, home));
  assert.equal(env.AGY_ACP_BIN, undefined);
}

// An equal or older CLI keeps the managed runtime.
for (const version of ["1.4.5", "1.0.0"]) {
  stubAgy(`echo ${version}`);
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const preference = await preferNewestAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "managed");
  assert.equal(preference.cliVersion, version);
  assert.equal(env.AGY_ACP_BIN, undefined);
  assert.equal(fs.existsSync(path.join(stateDir, "agy-acp-cli.sh")), false);
}

// A missing managed record still prefers a working CLI.
{
  stubAgy("echo 2.0.0");
  fs.rmSync(path.join(home, ".local"), { recursive: true, force: true });
  const env = freshEnv();
  const stateDir = freshStateDir();
  const preference = await preferNewestAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "cli");
  assert.equal(preference.managedVersion, undefined);
}

// A CLI without a usable `acp --version` is never selected.
for (const script of ["exit 1", "echo prerelease"]) {
  stubAgy(script);
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const preference = await preferNewestAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "managed");
  assert.equal(env.AGY_ACP_BIN, undefined);
}

// No CLI on PATH keeps the managed runtime.
{
  removeAgy();
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const preference = await preferNewestAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "managed");
  assert.equal(env.AGY_ACP_BIN, undefined);
}

fs.rmSync(work, { recursive: true, force: true });
console.log("acp-runtime-source: all selection cases passed");
