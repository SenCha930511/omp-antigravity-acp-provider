// Offline test of ACP runtime selection: a usable agy CLI wins, a broken or
// missing CLI falls back to managed, explicit env wins, and runtimeSource can
// pin cli or managed. Everything runs against stub binaries and fixture homes;
// no network, no real agy, no ACP session.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertSelectedAcpCliLaunch, selectAcpRuntime, resolveAcpPermissionProfile, resolveManagedAcpCommand, resolveAcpQuotaSource } from "../extension/acp-runtime-source.ts";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "acp-runtime-source-"));
const bin = path.join(work, "bin");
const home = path.join(work, "home");
fs.mkdirSync(bin, { recursive: true });

function stubAgy(script: string): void {
  const file = path.join(bin, "agy");
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(file, 0o755);
}

function stubAgyExe(script: string, directory = bin): void {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "agy.exe");
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(file, 0o755);
}

function removeAgy(): void {
  fs.rmSync(path.join(bin, "agy"), { force: true });
  fs.rmSync(path.join(bin, "agy.exe"), { force: true });
}

function setManagedVersion(version: string): void {
  const current = path.join(home, ".local", "opt", "agy-acp", "current");
  fs.mkdirSync(current, { recursive: true });
  fs.writeFileSync(path.join(current, "install-integrity.json"), JSON.stringify({ version }));
  const binary = path.join(current, "agy_acp_server.par");
  fs.writeFileSync(binary, "fixture managed binary");
  fs.chmodSync(binary, 0o755);
}

function freshStateDir(): string {
  const stateDir = path.join(work, `state-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

function freshEnv(): NodeJS.ProcessEnv {
  return { PATH: `${bin}${path.delimiter}/usr/bin:/bin` };
}

function setRuntimeSource(stateDir: string, runtimeSource: string): void {
  fs.writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ runtimeSource }));
}

// An explicit AGY_ACP_BIN always wins and nothing is written.
{
  const env = freshEnv();
  env.AGY_ACP_BIN = "/opt/custom-agy";
  const stateDir = freshStateDir();
  const preference = await selectAcpRuntime(stateDir, env, home);
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
  const preference = await selectAcpRuntime(stateDir, env, home);
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
  const repeated = await selectAcpRuntime(stateDir, env, home);
  assert.equal(repeated.source, "cli");
  assert.equal(repeated.cliVersion, "9.9.9");
  assert.equal(repeated.managedVersion, "1.4.5");
  assert.equal(resolveAcpPermissionProfile(repeated, "yolo").wireMode, "default");
  assert.equal(resolveAcpPermissionProfile(repeated, "yolo").autoApproveProcess, true);

  for (const marker of ["1", "0", undefined, ""]) {
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

// A record-write failure falls back to managed without selecting CLI.
{
  stubAgy("echo 9.9.9");
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  fs.mkdirSync(path.join(stateDir, "acp-runtime-source.json"));
  const preference = await selectAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "managed");
  assert.equal(env.AGY_ACP_BIN, undefined);
  assert.deepEqual(await resolveAcpQuotaSource(stateDir, env, home, "darwin", undefined, preference), {
    kind: "acp",
    command: path.join(home, ".local", "opt", "agy-acp", "current", "agy_acp_server.par"),
    args: [],
  });
}

// A working CLI is preferred even when managed is newer or equal.
for (const version of ["1.4.5", "1.0.0"]) {
  stubAgy(`echo ${version}`);
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const preference = await selectAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "cli");
  assert.equal(preference.cliVersion, version);
  assert.equal(env.AGY_ACP_BIN, path.join(stateDir, "agy-acp-cli.sh"));
  assert.equal(fs.existsSync(path.join(stateDir, "agy-acp-cli.sh")), true);
}

// A missing managed record still prefers a working CLI.
{
  stubAgy("echo 2.0.0");
  fs.rmSync(path.join(home, ".local"), { recursive: true, force: true });
  const env = freshEnv();
  const stateDir = freshStateDir();
  const preference = await selectAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "cli");
  assert.equal(preference.managedVersion, undefined);
}

// A CLI without a usable `acp --version` is never selected.
for (const script of ["exit 1", "echo prerelease"]) {
  stubAgy(script);
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const preference = await selectAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "managed");
  assert.equal(env.AGY_ACP_BIN, undefined);
}

// No CLI on PATH keeps the managed runtime.
{
  removeAgy();
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const preference = await selectAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "managed");
  assert.equal(env.AGY_ACP_BIN, undefined);
}

// A pinned CLI source wins over a newer managed runtime.
{
  stubAgy("echo 1.0.0");
  setManagedVersion("9.9.9");
  const env = freshEnv();
  const stateDir = freshStateDir();
  setRuntimeSource(stateDir, "cli");
  const preference = await selectAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "cli");
  assert.equal(env.AGY_ACP_BIN, path.join(stateDir, "agy-acp-cli.sh"));
}

// A pinned CLI source fails instead of downloading managed.
{
  removeAgy();
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  setRuntimeSource(stateDir, "cli");
  await assert.rejects(selectAcpRuntime(stateDir, env, home), /runtimeSource is "cli".*no usable agy CLI/);
  assert.equal(env.AGY_ACP_BIN, undefined);
  assert.equal(fs.existsSync(path.join(stateDir, "agy-acp-cli.sh")), false);
}

// A pinned managed source uses the runtime even when the CLI exists.
{
  stubAgy("echo 9.9.9");
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  setRuntimeSource(stateDir, "managed");
  const preference = await selectAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "managed");
  assert.equal(preference.managedVersion, "1.4.5");
  assert.equal(env.AGY_ACP_BIN, undefined);
}

// A pinned managed source fails instead of downloading it.
{
  stubAgy("echo 9.9.9");
  fs.rmSync(path.join(home, ".local"), { recursive: true, force: true });
  const env = freshEnv();
  const stateDir = freshStateDir();
  setRuntimeSource(stateDir, "managed");
  await assert.rejects(selectAcpRuntime(stateDir, env, home), /runtimeSource is "managed".*managed ACP runtime is missing/);
  assert.equal(env.AGY_ACP_BIN, undefined);
}

// An explicit non-wrapper AGY_ACP_BIN remains authoritative.
{
  stubAgy("echo 9.9.9");
  setManagedVersion("1.4.5");
  const env = freshEnv();
  env.AGY_ACP_BIN = "/opt/custom-agy";
  const stateDir = freshStateDir();
  setRuntimeSource(stateDir, "managed");
  const preference = await selectAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "env");
  assert.equal(env.AGY_ACP_BIN, "/opt/custom-agy");
}

// An invalid pinned source fails closed instead of selecting automatically.
{
  stubAgy("echo 9.9.9");
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  setRuntimeSource(stateDir, "runtime");
  await assert.rejects(selectAcpRuntime(stateDir, env, home), /runtimeSource must be "auto", "cli", or "managed"/);
  assert.equal(env.AGY_ACP_BIN, undefined);
}

// Automatic CLI selection keeps quota on the same CLI wrapper as inference.
{
  stubAgy("echo 3.0.0");
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const preference = await selectAcpRuntime(stateDir, env, home);
  assert.equal(preference.source, "cli");
  const wrapper = path.join(stateDir, "agy-acp-cli.sh");
  assert.equal(assertSelectedAcpCliLaunch(stateDir, preference, env, "darwin"), undefined);
  assert.equal(env.AGY_ACP_BIN, wrapper);
  const command = path.join(home, ".local", "opt", "agy-acp", "current", "agy_acp_server.par");

  assert.deepEqual(resolveManagedAcpCommand(home, "linux"), { command, args: ["--uid="] });
  const explicit = { ...env, AGY_ACP_BIN: "/opt/custom-quota-bin" };
  assert.equal(assertSelectedAcpCliLaunch(stateDir, { source: "env" }, explicit, "darwin"), undefined);
  assert.equal(explicit.AGY_ACP_BIN, "/opt/custom-quota-bin");
}

// The agy.exe stub is a POSIX sh script, so the win32 path can only be simulated off-Windows.
if (process.platform !== "win32") {
  removeAgy();
  stubAgyExe("echo 9.9.9");
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const preference = await selectAcpRuntime(stateDir, env, home, "win32");
  assert.equal(preference.source, "cli");
  assert.equal(preference.cliVersion, "9.9.9");
  const wrapper = path.join(stateDir, "agy-acp-cli.cmd");
  assert.equal(env.AGY_ACP_BIN, wrapper);
  const script = fs.readFileSync(wrapper, "utf8");
  assert.match(script, /^@echo off\r\n/);
  assert.match(script, /acp --app_data_dir=antigravity-acp/);
  assert.match(script, /if "%OMP_ACP_DANGEROUSLY_SKIP_PERMISSIONS%"=="1" set "OMP_ACP_EXTRA=--dangerously-skip-permissions"/);
  assert.doesNotMatch(script, /if defined[^\r\n]*\(/);
  assert.doesNotThrow(() => assertSelectedAcpCliLaunch(stateDir, preference, env, "win32"));
  assert.throws(() => assertSelectedAcpCliLaunch(stateDir, preference, env, "linux"), /wrapper is missing, changed/);
  const repeated = await selectAcpRuntime(stateDir, env, home, "win32");
  assert.equal(repeated.source, "cli");
  assert.equal(assertSelectedAcpCliLaunch(stateDir, preference, env, "win32"), undefined);
  assert.equal(env.AGY_ACP_BIN, wrapper);
  const parenBin = path.join(work, "Program Files (x86)", "bin");
  stubAgyExe("echo 9.9.9", parenBin);
  setManagedVersion("1.4.5");
  const parenEnv = { PATH: `${parenBin}${path.delimiter}/usr/bin:/bin` };
  const parenStateDir = freshStateDir();
  const parenPreference = await selectAcpRuntime(parenStateDir, parenEnv, home, "win32");
  assert.equal(parenPreference.source, "cli");
  const parenScript = fs.readFileSync(path.join(parenStateDir, "agy-acp-cli.cmd"), "utf8");
  assert.match(parenScript, /Program Files \(x86\)/);
  assert.doesNotMatch(parenScript, /if defined[^\r\n]*\(/);
}

{
  removeAgy();
  setManagedVersion("1.4.5");
  const stateDir = freshStateDir();
  const wrapper = path.join(stateDir, "agy-acp-cli.sh");
  fs.writeFileSync(wrapper, "#!/bin/sh\nexit 0\n");
  fs.writeFileSync(path.join(stateDir, "acp-runtime-source.json"), JSON.stringify({
    source: "cli",
    cliPath: path.join(work, "missing-agy"),
    cliVersion: "9.9.9",
  }));
  const env = { PATH: "/usr/bin:/bin", AGY_ACP_BIN: wrapper };
  const preference = await selectAcpRuntime(stateDir, env, home, "darwin");
  assert.equal(preference.source, "managed");
  assert.equal(env.AGY_ACP_BIN, undefined);
}

{
  removeAgy();
  const recorded = path.join(work, "recorded-agy");
  fs.writeFileSync(recorded, "#!/bin/sh\necho 9.9.9\n");
  fs.chmodSync(recorded, 0o755);
  const stateDir = freshStateDir();
  const wrapper = path.join(stateDir, "agy-acp-cli.sh");
  fs.writeFileSync(path.join(stateDir, "acp-runtime-source.json"), JSON.stringify({
    source: "cli",
    cliPath: recorded,
    cliVersion: "9.9.9",
  }));
  const env = { PATH: "/usr/bin:/bin", AGY_ACP_BIN: wrapper };
  const preference = await selectAcpRuntime(stateDir, env, home, "darwin");
  assert.equal(preference.source, "cli");
  assert.equal(preference.cliPath, recorded);
  assert.equal(env.AGY_ACP_BIN, wrapper);
  assert.equal(fs.existsSync(wrapper), true);
}

// Quota source resolution is read-only: auto prefers a usable CLI and never
// writes the wrapper or the recorded decision.
{
  stubAgy("echo 4.0.0");
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const source = await resolveAcpQuotaSource(stateDir, env, home, "darwin");
  assert.deepEqual(source, { kind: "cli", cliPath: path.join(bin, "agy") });
  assert.equal(env.AGY_ACP_BIN, undefined);
  assert.equal(fs.existsSync(path.join(stateDir, "agy-acp-cli.sh")), false);
  assert.equal(fs.existsSync(path.join(stateDir, "acp-runtime-source.json")), false);
}

// Auto without a usable CLI selects the installed managed runtime.
{
  removeAgy();
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  assert.deepEqual(await resolveAcpQuotaSource(stateDir, env, home, "darwin"), {
    kind: "acp",
    command: path.join(home, ".local", "opt", "agy-acp", "current", "agy_acp_server.par"),
    args: [],
  });
  assert.equal(env.AGY_ACP_BIN, undefined);
}

// A pinned CLI source never falls back to managed or downloads anything.
{
  removeAgy();
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  setRuntimeSource(stateDir, "cli");
  assert.equal(await resolveAcpQuotaSource(stateDir, env, home, "darwin"), undefined);
  assert.equal(env.AGY_ACP_BIN, undefined);
  assert.equal(fs.existsSync(path.join(stateDir, "agy-acp-cli.sh")), false);
  assert.equal(fs.existsSync(path.join(stateDir, "acp-runtime-source.json")), false);
}

// An explicit non-wrapper AGY_ACP_BIN reports the ACP runtime.
{
  const env = freshEnv();
  env.AGY_ACP_BIN = "/opt/custom-agy";
  const stateDir = freshStateDir();
  assert.deepEqual(await resolveAcpQuotaSource(stateDir, env, home, "darwin"), {
    kind: "acp",
    command: "/opt/custom-agy",
    args: [],
  });
  assert.equal(env.AGY_ACP_BIN, "/opt/custom-agy");
}

// An explicit runtime retains home expansion and native Linux launch arguments.
{
  const explicit = path.join(home, "bin", "runtime-native");
  fs.mkdirSync(path.dirname(explicit), { recursive: true });
  fs.copyFileSync("/bin/echo", explicit);
  fs.chmodSync(explicit, 0o755);
  const env = freshEnv();
  env.AGY_ACP_BIN = "~/bin/runtime-native";
  assert.deepEqual(await resolveAcpQuotaSource(freshStateDir(), env, home, "linux"), {
    kind: "acp", command: explicit, args: ["--uid="],
  });
}

// The adapter wrapper prefers a recorded executable CLI without writing it.
{
  removeAgy();
  const recorded = path.join(work, "quota-recorded-agy");
  fs.writeFileSync(recorded, "#!/bin/sh\necho 9.9.9\n");
  fs.chmodSync(recorded, 0o755);
  const stateDir = freshStateDir();
  const wrapper = path.join(stateDir, "agy-acp-cli.sh");
  fs.writeFileSync(path.join(stateDir, "acp-runtime-source.json"), JSON.stringify({
    source: "cli",
    cliPath: recorded,
    cliVersion: "9.9.9",
  }));
  const env = { PATH: "/usr/bin:/bin", AGY_ACP_BIN: wrapper };
  assert.deepEqual(await resolveAcpQuotaSource(stateDir, env, home, "darwin"), { kind: "cli", cliPath: recorded });
  assert.equal(env.AGY_ACP_BIN, wrapper);
  assert.equal(fs.existsSync(wrapper), false);
}

// A pinned managed source without an installed runtime reports nothing.
{
  removeAgy();
  fs.rmSync(path.join(home, ".local"), { recursive: true, force: true });
  const env = freshEnv();
  const stateDir = freshStateDir();
  setRuntimeSource(stateDir, "managed");
  assert.equal(await resolveAcpQuotaSource(stateDir, env, home, "darwin"), undefined);
  assert.equal(env.AGY_ACP_BIN, undefined);
}

fs.rmSync(work, { recursive: true, force: true });
console.log("acp-runtime-source: all selection cases passed");
