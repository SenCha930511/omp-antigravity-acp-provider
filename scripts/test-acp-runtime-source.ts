// Offline test of the ACP launch plan: a usable agy CLI wins, a broken or
// missing CLI falls back to managed, an explicit non-wrapper AGY_ACP_BIN wins,
// and runtimeSource can pin cli or managed. Every plan carries its exact spawn
// target, so spawning never depends on later AGY_ACP_BIN state. Everything runs
// against stub binaries and fixture homes; no network, no real agy, no ACP
// session.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  inspectRuntimeLaunchPlan,
  quotaSourceForPlan,
  resolveAcpPermissionProfile,
  resolveLaunchSpawn,
  resolveManagedAcpCommand,
  resolveRuntimeLaunchPlan,
  type LaunchOptions,
  type RuntimeLaunchPlan,
} from "../extension/runtime/launch.ts";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "acp-runtime-source-"));
const bin = path.join(work, "bin");
const home = path.join(work, "home");
fs.mkdirSync(bin, { recursive: true });

function stubAgy(script: string, directory = bin): string {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "agy");
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function stubAgyExe(script: string, directory = bin): string {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "agy.exe");
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function stubAgyCmd(version = "9.9.9", directory = bin): string {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "agy.cmd");
  const script = process.platform === "win32"
    ? `@echo off\r\nif "%~1"=="acp" if "%~2"=="--version" echo ${version}\r\nexit /b 0\r\n`
    : `#!/bin/sh\necho ${version}\n`;
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
  return file;
}

function removeAgy(): void {
  fs.rmSync(path.join(bin, "agy"), { force: true });
  fs.rmSync(path.join(bin, "agy.exe"), { force: true });
  fs.rmSync(path.join(bin, "agy.cmd"), { force: true });
  fs.rmSync(path.join(bin, "agy.bat"), { force: true });
}

function setManagedVersion(version: string): void {
  const current = path.join(home, ".local", "opt", "agy-acp", "current");
  fs.mkdirSync(current, { recursive: true });
  fs.writeFileSync(path.join(current, "install-integrity.json"), JSON.stringify({ version }));
  const binary = path.join(current, "agy_acp_server.par");
  fs.writeFileSync(binary, "fixture managed binary");
  fs.chmodSync(binary, 0o755);
}

function managedBinary(): string {
  return path.join(home, ".local", "opt", "agy-acp", "current", "agy_acp_server.par");
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

function wrapperPath(stateDir: string, platform: NodeJS.Platform = "darwin"): string {
  return path.join(stateDir, platform === "win32" ? "agy-acp-cli.cmd" : "agy-acp-cli.sh");
}

function recordPath(stateDir: string): string {
  return path.join(stateDir, "acp-runtime-source.json");
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function planFor(stateDir: string, options: LaunchOptions): Promise<RuntimeLaunchPlan> {
  return resolveRuntimeLaunchPlan(stateDir, { home, platform: "darwin", ...options });
}

function inspectFor(stateDir: string, options: LaunchOptions): Promise<RuntimeLaunchPlan> {
  return inspectRuntimeLaunchPlan(stateDir, { home, platform: "darwin", ...options });
}

function assertPlanUntouched(stateDir: string, env: NodeJS.ProcessEnv, label: string): void {
  assert.equal(env.AGY_ACP_BIN, undefined, `${label}: AGY_ACP_BIN must stay unset`);
  assert.equal(fs.existsSync(wrapperPath(stateDir)), false, `${label}: no wrapper may be written`);
  assert.equal(fs.existsSync(recordPath(stateDir)), false, `${label}: no record may be written`);
}

// An explicit AGY_ACP_BIN always wins and nothing is written.
{
  const env = freshEnv();
  env.AGY_ACP_BIN = "/opt/custom-agy";
  const stateDir = freshStateDir();
  const plan = await planFor(stateDir, { env });
  assert.equal(plan.source, "env");
  assert.equal(plan.installManaged, false);
  assert.deepEqual(plan.target, { kind: "direct", value: { command: "/opt/custom-agy", args: [] } });
  assert.deepEqual(plan.quota, { kind: "acp", value: { command: "/opt/custom-agy", args: [] } });
  assert.deepEqual(quotaSourceForPlan(plan), { kind: "acp", command: "/opt/custom-agy", args: [] });
  assert.equal(env.AGY_ACP_BIN, "/opt/custom-agy");
  assert.equal(fs.existsSync(wrapperPath(stateDir)), false);
  assert.equal(fs.existsSync(recordPath(stateDir)), false);
}

// A working CLI takes over through a generated executable wrapper, records the
// decision, and exposes the wrapper as the only CLI spawn target.
{
  const argvRecord = path.join(work, "agy-argv.txt");
  stubAgy(`if [ "$1" = "acp" ] && [ "$2" = "--version" ]; then\n  echo 9.9.9\n  exit 0\nfi\nprintf '%s\\n' "$@" > '${argvRecord}'`);
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const plan = await planFor(stateDir, { env });
  assert.equal(plan.source, "cli");
  assert.equal(plan.cliVersion, "9.9.9");
  assert.equal(plan.managedVersion, "1.4.5");
  assert.equal(plan.installManaged, false);
  const wrapper = wrapperPath(stateDir);
  assert.deepEqual(plan.target, { kind: "wrapper", path: wrapper, sha256: sha256(wrapper) });
  assert.deepEqual(plan.quota, { kind: "cli", cliPath: path.join(bin, "agy") });
  assert.deepEqual(quotaSourceForPlan(plan), { kind: "cli", cliPath: path.join(bin, "agy") });
  assert.equal(env.AGY_ACP_BIN, undefined);
  const script = fs.readFileSync(wrapper, "utf8");
  assert.ok(script.startsWith("#!/bin/sh\n"));
  assert.ok(script.includes(`exec '${path.join(bin, "agy")}' acp --app_data_dir=antigravity-acp "$@"`));
  fs.accessSync(wrapper, fs.constants.X_OK);
  const record = JSON.parse(fs.readFileSync(recordPath(stateDir), "utf8"));
  assert.equal(record.source, "cli");
  assert.equal(record.cliVersion, "9.9.9");
  assert.equal(record.cliPath, path.join(bin, "agy"));
  assert.equal(typeof record.decidedAt, "string");

  const repeated = await planFor(stateDir, { env });
  assert.equal(repeated.source, "cli");
  assert.equal(repeated.cliVersion, "9.9.9");
  assert.equal(repeated.managedVersion, "1.4.5");
  assert.deepEqual(repeated.target, plan.target);
  assert.equal(resolveAcpPermissionProfile(repeated, "yolo").wireMode, "default");
  assert.equal(resolveAcpPermissionProfile(repeated, "yolo").autoApproveProcess, true);

  for (const marker of ["1", "0", undefined, ""]) {
    const childEnv = freshEnv();
    if (marker !== undefined) childEnv.OMP_ACP_DANGEROUSLY_SKIP_PERMISSIONS = marker;
    fs.rmSync(argvRecord, { force: true });
    const launch = resolveLaunchSpawn(plan);
    assert.equal(launch.command, wrapper);
    assert.deepEqual(launch.args, []);
    const result = spawnSync(launch.command, [...launch.args, "--fixture-argument"], { env: childEnv, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const argv = fs.readFileSync(argvRecord, "utf8").trimEnd().split("\n");
    assert.equal(argv.filter(value => value === "--dangerously-skip-permissions").length, marker === "1" ? 1 : 0,
      `dangerous flag count with marker ${JSON.stringify(marker)}`);
    assert.deepEqual(argv.slice(0, 2), ["acp", "--app_data_dir=antigravity-acp"]);
    assert.equal(argv.at(-1), "--fixture-argument");
  }

  // The wrapper bytes are pinned: any replacement fails before spawning.
  fs.writeFileSync(wrapper, "#!/bin/sh\nexit 0\n");
  assert.throws(() => resolveLaunchSpawn(plan), /changed after selection/);
  fs.rmSync(wrapper);
  assert.throws(() => resolveLaunchSpawn(plan), /missing/);
  const restored = await planFor(stateDir, { env });
  assert.equal(restored.source, "cli");
  fs.chmodSync(wrapper, 0o644);
  assert.throws(() => resolveLaunchSpawn(restored), /not executable/);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(resolveLaunchSpawn(restored).command, wrapper);
}

// A record-write failure falls back to managed without selecting CLI.
{
  stubAgy("echo 9.9.9");
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  fs.mkdirSync(recordPath(stateDir));
  const plan = await planFor(stateDir, { env });
  assert.equal(plan.source, "managed");
  assert.equal(plan.installManaged, true);
  assert.deepEqual(plan.target, { kind: "direct", value: { command: managedBinary(), args: [] } });
  assert.deepEqual(quotaSourceForPlan(plan), { kind: "acp", command: managedBinary(), args: [] });
  assert.equal(env.AGY_ACP_BIN, undefined);
}

// A working CLI is preferred even when managed is newer or equal.
for (const version of ["1.4.5", "1.0.0"]) {
  stubAgy(`echo ${version}`);
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const plan = await planFor(stateDir, { env });
  assert.equal(plan.source, "cli");
  assert.equal(plan.cliVersion, version);
  assert.equal(plan.target?.kind, "wrapper");
  assert.equal(plan.target?.kind === "wrapper" ? plan.target.path : undefined, wrapperPath(stateDir));
  assert.equal(fs.existsSync(wrapperPath(stateDir)), true);
}

// A missing managed record still prefers a working CLI.
{
  stubAgy("echo 2.0.0");
  fs.rmSync(path.join(home, ".local"), { recursive: true, force: true });
  const env = freshEnv();
  const stateDir = freshStateDir();
  const plan = await planFor(stateDir, { env });
  assert.equal(plan.source, "cli");
  assert.equal(plan.managedVersion, undefined);
}

// A CLI without a usable `acp --version` is never selected.
for (const script of ["exit 1", "echo prerelease"]) {
  stubAgy(script);
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const plan = await planFor(stateDir, { env });
  assert.equal(plan.source, "managed");
  assert.equal(plan.installManaged, true);
  assert.deepEqual(plan.target, { kind: "direct", value: { command: managedBinary(), args: [] } });
  assert.equal(env.AGY_ACP_BIN, undefined);
}

// No CLI on PATH keeps the managed runtime.
{
  removeAgy();
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const plan = await planFor(stateDir, { env });
  assert.equal(plan.source, "managed");
  assert.equal(plan.installManaged, true);
  assert.deepEqual(plan.target, { kind: "direct", value: { command: managedBinary(), args: [] } });
  assert.equal(env.AGY_ACP_BIN, undefined);
}

// A pinned CLI source wins over a newer managed runtime.
{
  stubAgy("echo 1.0.0");
  setManagedVersion("9.9.9");
  const env = freshEnv();
  const stateDir = freshStateDir();
  setRuntimeSource(stateDir, "cli");
  const plan = await planFor(stateDir, { env });
  assert.equal(plan.source, "cli");
  assert.equal(plan.installManaged, false);
  assert.equal(plan.target?.kind === "wrapper" ? plan.target.path : undefined, wrapperPath(stateDir));
  assert.equal(env.AGY_ACP_BIN, undefined);
}

// A pinned CLI source fails instead of downloading managed.
{
  removeAgy();
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  setRuntimeSource(stateDir, "cli");
  await assert.rejects(planFor(stateDir, { env }), /runtimeSource is "cli".*no usable agy CLI/);
  assert.equal(env.AGY_ACP_BIN, undefined);
  assert.equal(fs.existsSync(wrapperPath(stateDir)), false);
}

// A pinned managed source uses the runtime even when the CLI exists.
{
  stubAgy("echo 9.9.9");
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  setRuntimeSource(stateDir, "managed");
  const plan = await planFor(stateDir, { env });
  assert.equal(plan.source, "managed");
  assert.equal(plan.managedVersion, "1.4.5");
  assert.equal(plan.installManaged, false);
  assert.deepEqual(plan.target, { kind: "direct", value: { command: managedBinary(), args: [] } });
  assert.equal(env.AGY_ACP_BIN, undefined);
  assert.equal(fs.existsSync(wrapperPath(stateDir)), false);
}

// A pinned managed source fails instead of downloading it.
{
  stubAgy("echo 9.9.9");
  fs.rmSync(path.join(home, ".local"), { recursive: true, force: true });
  const env = freshEnv();
  const stateDir = freshStateDir();
  setRuntimeSource(stateDir, "managed");
  await assert.rejects(planFor(stateDir, { env }), /runtimeSource is "managed".*managed ACP runtime is missing/);
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
  const plan = await planFor(stateDir, { env });
  assert.equal(plan.source, "env");
  assert.deepEqual(plan.target, { kind: "direct", value: { command: "/opt/custom-agy", args: [] } });
  assert.equal(env.AGY_ACP_BIN, "/opt/custom-agy");
}

// An invalid pinned source fails closed instead of selecting automatically.
{
  stubAgy("echo 9.9.9");
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  setRuntimeSource(stateDir, "runtime");
  await assert.rejects(planFor(stateDir, { env }), /runtimeSource must be "auto", "cli", or "managed"/);
  assert.equal(env.AGY_ACP_BIN, undefined);
}

// Automatic CLI selection keeps quota on the same CLI wrapper as inference.
{
  stubAgy("echo 3.0.0");
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const plan = await planFor(stateDir, { env });
  assert.equal(plan.source, "cli");
  assert.deepEqual(quotaSourceForPlan(plan), { kind: "cli", cliPath: path.join(bin, "agy") });
  assert.equal(plan.target?.kind === "wrapper" ? plan.target.path : undefined, wrapperPath(stateDir));
  const command = managedBinary();
  assert.deepEqual(resolveManagedAcpCommand(home, "linux"), { command, args: ["--uid="] });
  const explicit = { ...env, AGY_ACP_BIN: "/opt/custom-quota-bin" };
  const explicitPlan = await planFor(stateDir, { env: explicit });
  assert.equal(explicitPlan.source, "env");
  assert.deepEqual(quotaSourceForPlan(explicitPlan), { kind: "acp", command: "/opt/custom-quota-bin", args: [] });
  assert.equal(explicit.AGY_ACP_BIN, "/opt/custom-quota-bin");
}

// The agy.exe stub is a POSIX sh script, so the win32 path can only be simulated off-Windows.
if (process.platform !== "win32") {
  removeAgy();
  stubAgyExe("echo 9.9.9");
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const plan = await planFor(stateDir, { env, platform: "win32" });
  assert.equal(plan.source, "cli");
  assert.equal(plan.cliVersion, "9.9.9");
  const wrapper = wrapperPath(stateDir, "win32");
  assert.deepEqual(plan.target, { kind: "wrapper", path: wrapper, sha256: sha256(wrapper) });
  assert.equal(env.AGY_ACP_BIN, undefined);
  const script = fs.readFileSync(wrapper, "utf8");
  assert.match(script, /^@echo off\r\n/);
  assert.match(script, /acp --app_data_dir=antigravity-acp/);
  assert.match(script, /if "%OMP_ACP_DANGEROUSLY_SKIP_PERMISSIONS%"=="1" set "OMP_ACP_EXTRA=--dangerously-skip-permissions"/);
  assert.doesNotMatch(script, /if defined[^\r\n]*\(/);
  // Windows cannot spawn a .cmd file directly, so the wrapper goes through the
  // command processor; the plan still names the exact wrapper path.
  const winSpawn = resolveLaunchSpawn(plan, "win32");
  assert.equal(winSpawn.command, process.env.ComSpec ?? "cmd.exe");
  assert.deepEqual(winSpawn.args, ["/d", "/s", "/e:on", "/v:off", "/c", `call "${wrapper}"`]);
  // Off Windows the same plan still names the exact wrapper and spawns it directly.
  assert.deepEqual(resolveLaunchSpawn(plan, "linux"), { command: wrapper, args: [] });
  const repeated = await planFor(stateDir, { env, platform: "win32" });
  assert.equal(repeated.source, "cli");
  assert.deepEqual(repeated.target, plan.target);
  assert.equal(env.AGY_ACP_BIN, undefined);
  const parenBin = path.join(work, "Program Files (x86)", "bin");
  stubAgyExe("echo 9.9.9", parenBin);
  setManagedVersion("1.4.5");
  const parenEnv = { PATH: `${parenBin}${path.delimiter}/usr/bin:/bin` };
  const parenStateDir = freshStateDir();
  const parenPlan = await planFor(parenStateDir, { env: parenEnv, platform: "win32" });
  assert.equal(parenPlan.source, "cli");
  const parenScript = fs.readFileSync(wrapperPath(parenStateDir, "win32"), "utf8");
  assert.match(parenScript, /Program Files \(x86\)/);
  assert.doesNotMatch(parenScript, /if defined[^\r\n]*\(/);
}

// Windows PATH discovery must find npm-style .cmd shims, not only a POSIX
// shim or a native .exe. Probing is the local fixture, never the real CLI.
{
  removeAgy();
  const cli = stubAgyCmd("1.5.8");
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const plan = await planFor(stateDir, { env, platform: "win32" });
  assert.equal(plan.source, "cli", "agy.cmd on PATH must be eligible on Windows");
  assert.equal(plan.cliPath, cli);
  assert.equal(plan.cliVersion, "1.5.8");
  assert.equal(plan.target?.kind === "wrapper" ? plan.target.path : undefined, wrapperPath(stateDir, "win32"));
  assert.equal(env.AGY_ACP_BIN, undefined);

  // An identical wrapper path with different casing is still this adapter's
  // stale wrapper on Windows, not an external override that pins stale state.
  const mixedCaseWrapper = wrapperPath(stateDir, "win32").replace(/agy-acp-cli\.cmd$/u, "AGY-ACP-CLI.CMD");
  const mixedCaseEnv = { ...env, AGY_ACP_BIN: mixedCaseWrapper };
  const recovered = await planFor(stateDir, { env: mixedCaseEnv, platform: "win32" });
  assert.equal(recovered.source, "cli", "wrapper identity must be case-insensitive on Windows");
  assert.equal(recovered.cliPath, cli);
}

// A wrapper already named by AGY_ACP_BIN is the adapter's own decision, not a
// user override, so an in-place upgrade re-detects the CLI profile.
{
  stubAgy("echo 1.5.3");
  setManagedVersion("1.4.5");
  const stateDir = freshStateDir();
  const wrapper = wrapperPath(stateDir);
  fs.writeFileSync(wrapper, "#!/bin/sh\nexit 0\n");
  const env = freshEnv();
  env.AGY_ACP_BIN = wrapper;
  const plan = await planFor(stateDir, { env });
  assert.equal(plan.source, "cli");
  assert.equal(plan.cliVersion, "1.5.3");
  assert.deepEqual(plan.target, { kind: "wrapper", path: wrapper, sha256: sha256(wrapper) });
  assert.equal(env.AGY_ACP_BIN, wrapper);
  assert.equal(resolveAcpPermissionProfile(plan, "yolo").autoApproveProcess, true);
  assert.equal(resolveAcpPermissionProfile(plan, "auto_edit").wireMode, "accept-edits");
}

// A stale wrapper in AGY_ACP_BIN with an unusable record falls back to managed
// without touching the environment.
{
  removeAgy();
  setManagedVersion("1.4.5");
  const stateDir = freshStateDir();
  const wrapper = wrapperPath(stateDir);
  fs.writeFileSync(wrapper, "#!/bin/sh\nexit 0\n");
  fs.writeFileSync(recordPath(stateDir), JSON.stringify({
    source: "cli",
    cliPath: path.join(work, "missing-agy"),
    cliVersion: "9.9.9",
  }));
  const env = { PATH: "/usr/bin:/bin", AGY_ACP_BIN: wrapper };
  const plan = await planFor(stateDir, { env });
  assert.equal(plan.source, "managed");
  assert.equal(plan.installManaged, true);
  assert.deepEqual(plan.target, { kind: "direct", value: { command: managedBinary(), args: [] } });
  assert.equal(env.AGY_ACP_BIN, wrapper);
}

// The adapter wrapper prefers a recorded executable CLI and refreshes the wrapper.
{
  removeAgy();
  const recorded = path.join(work, "recorded-agy");
  fs.writeFileSync(recorded, "#!/bin/sh\necho 9.9.9\n");
  fs.chmodSync(recorded, 0o755);
  const stateDir = freshStateDir();
  const wrapper = wrapperPath(stateDir);
  fs.writeFileSync(recordPath(stateDir), JSON.stringify({
    source: "cli",
    cliPath: recorded,
    cliVersion: "9.9.9",
  }));
  const env = { PATH: "/usr/bin:/bin", AGY_ACP_BIN: wrapper };
  const plan = await planFor(stateDir, { env });
  assert.equal(plan.source, "cli");
  assert.equal(plan.cliPath, recorded);
  assert.deepEqual(plan.target, { kind: "wrapper", path: wrapper, sha256: sha256(wrapper) });
  assert.equal(env.AGY_ACP_BIN, wrapper);
  assert.equal(fs.existsSync(wrapper), true);
}

// Unparseable or mistyped external records are rejected at the boundary and
// never trusted as a CLI selection.
{
  removeAgy();
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const invalid = [
    "not json",
    "[]",
    "\"cli\"",
    "null",
    JSON.stringify({ source: "managed" }),
    JSON.stringify({ source: "cli", cliPath: 42, cliVersion: "9.9.9" }),
    JSON.stringify({ source: "cli", cliPath: path.join(work, "recorded-agy") }),
    JSON.stringify({ source: "cli", cliPath: "", cliVersion: "9.9.9" }),
  ];
  for (const payload of invalid) {
    const stateDir = freshStateDir();
    const wrapper = wrapperPath(stateDir);
    fs.writeFileSync(wrapper, "#!/bin/sh\nexit 0\n");
    fs.writeFileSync(recordPath(stateDir), payload);
    const plan = await planFor(stateDir, { env: { ...env, AGY_ACP_BIN: wrapper } });
    assert.equal(plan.source, "managed", `record ${payload} must not select a CLI`);
    assert.deepEqual(plan.target, { kind: "direct", value: { command: managedBinary(), args: [] } });
  }
}

// Quota inspection is read-only: auto prefers a usable CLI and never writes the
// wrapper or the recorded decision.
{
  stubAgy("echo 4.0.0");
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const plan = await inspectFor(stateDir, { env });
  assert.equal(plan.source, "cli");
  assert.deepEqual(quotaSourceForPlan(plan), { kind: "cli", cliPath: path.join(bin, "agy") });
  assertPlanUntouched(stateDir, env, "inspect auto cli");
}

// Auto without a usable CLI reports the installed managed runtime.
{
  removeAgy();
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  const plan = await inspectFor(stateDir, { env });
  assert.equal(plan.source, "managed");
  assert.deepEqual(quotaSourceForPlan(plan), { kind: "acp", command: managedBinary(), args: [] });
  assertPlanUntouched(stateDir, env, "inspect auto managed");
}

// A pinned CLI source never falls back to managed or downloads anything.
{
  removeAgy();
  setManagedVersion("1.4.5");
  const env = freshEnv();
  const stateDir = freshStateDir();
  setRuntimeSource(stateDir, "cli");
  await assert.rejects(inspectFor(stateDir, { env }), /runtimeSource is "cli"/);
  assert.equal(env.AGY_ACP_BIN, undefined);
  assert.equal(fs.existsSync(wrapperPath(stateDir)), false);
  assert.equal(fs.existsSync(recordPath(stateDir)), false);
}

// An explicit non-wrapper AGY_ACP_BIN reports the ACP runtime.
{
  const env = freshEnv();
  env.AGY_ACP_BIN = "/opt/custom-agy";
  const stateDir = freshStateDir();
  const plan = await inspectFor(stateDir, { env });
  assert.equal(plan.source, "env");
  assert.deepEqual(quotaSourceForPlan(plan), { kind: "acp", command: "/opt/custom-agy", args: [] });
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
  const plan = await inspectFor(freshStateDir(), { env, platform: "linux" });
  assert.deepEqual(plan.target, { kind: "direct", value: { command: explicit, args: ["--uid="] } });
  assert.deepEqual(quotaSourceForPlan(plan), { kind: "acp", command: explicit, args: ["--uid="] });
}

// The adapter wrapper prefers a recorded executable CLI without writing it.
{
  removeAgy();
  const recorded = path.join(work, "quota-recorded-agy");
  fs.writeFileSync(recorded, "#!/bin/sh\necho 9.9.9\n");
  fs.chmodSync(recorded, 0o755);
  const stateDir = freshStateDir();
  const wrapper = wrapperPath(stateDir);
  fs.writeFileSync(recordPath(stateDir), JSON.stringify({
    source: "cli",
    cliPath: recorded,
    cliVersion: "9.9.9",
  }));
  const env = { PATH: "/usr/bin:/bin", AGY_ACP_BIN: wrapper };
  const plan = await inspectFor(stateDir, { env });
  assert.equal(plan.source, "cli");
  assert.deepEqual(quotaSourceForPlan(plan), { kind: "cli", cliPath: recorded });
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
  await assert.rejects(inspectFor(stateDir, { env }), /runtimeSource is "managed"/);
  assert.equal(env.AGY_ACP_BIN, undefined);
}

// An auto plan with no installed runtime has no spawn target and no quota; it
// reports that installation is still required.
{
  removeAgy();
  fs.rmSync(path.join(home, ".local"), { recursive: true, force: true });
  const env = freshEnv();
  const stateDir = freshStateDir();
  const plan = await planFor(stateDir, { env });
  assert.equal(plan.source, "managed");
  assert.equal(plan.installManaged, true);
  assert.equal(plan.target, undefined);
  assert.deepEqual(plan.quota, { kind: "none" });
  assert.equal(quotaSourceForPlan(plan), undefined);
  assert.throws(() => resolveLaunchSpawn(plan), /No ACP runtime is installed/);
  assert.equal(env.AGY_ACP_BIN, undefined);
}

// The environment is only ever read: a frozen env object must resolve every
// channel without a write, and the caller's env must be identical after.
{
  stubAgy("echo 5.0.0");
  setManagedVersion("1.4.5");
  const cliEnv = freshEnv();
  const cliState = freshStateDir();
  const cliBefore = { ...cliEnv };
  Object.freeze(cliEnv);
  const cliPlan = await planFor(cliState, { env: cliEnv });
  assert.equal(cliPlan.source, "cli");
  assert.deepEqual(cliEnv, cliBefore, "cli: env must not be mutated");

  const envEnv = freshEnv();
  envEnv.AGY_ACP_BIN = "/opt/custom-agy";
  const envState = freshStateDir();
  const envBefore = { ...envEnv };
  Object.freeze(envEnv);
  const explicitPlan = await planFor(envState, { env: envEnv });
  assert.equal(explicitPlan.source, "env");
  assert.deepEqual(envEnv, envBefore, "env: env must not be mutated");

  removeAgy();
  const managedEnv = freshEnv();
  const managedState = freshStateDir();
  const managedBefore = { ...managedEnv };
  Object.freeze(managedEnv);
  const managedPlan = await planFor(managedState, { env: managedEnv });
  assert.equal(managedPlan.source, "managed");
  assert.deepEqual(managedEnv, managedBefore, "managed: env must not be mutated");
}

// Two plans resolved in one process stay independent, and spawning keeps
// working after AGY_ACP_BIN is absent or points somewhere else.
{
  const binA = path.join(work, "bin-a");
  const binB = path.join(work, "bin-b");
  const recordA = path.join(work, "agy-a-argv.txt");
  const recordB = path.join(work, "agy-b-argv.txt");
  stubAgy(`if [ "$1" = "acp" ] && [ "$2" = "--version" ]; then echo 1.5.3; exit 0; fi\nprintf '%s\\n' "$@" > '${recordA}'`, binA);
  stubAgy(`if [ "$1" = "acp" ] && [ "$2" = "--version" ]; then echo 1.6.0; exit 0; fi\nprintf '%s\\n' "$@" > '${recordB}'`, binB);
  const stateA = freshStateDir();
  const stateB = freshStateDir();
  const envA = { PATH: `${binA}${path.delimiter}/usr/bin:/bin` };
  const envB = { PATH: `${binB}${path.delimiter}/usr/bin:/bin` };
  const planA = await planFor(stateA, { env: envA });
  const planB = await planFor(stateB, { env: envB });
  assert.equal(planA.source, "cli");
  assert.equal(planB.source, "cli");
  assert.equal(planA.cliPath, path.join(binA, "agy"));
  assert.equal(planB.cliPath, path.join(binB, "agy"));
  assert.notEqual(planA.target?.kind === "wrapper" ? planA.target.sha256 : undefined,
    planB.target?.kind === "wrapper" ? planB.target.sha256 : undefined);
  const previousBin = process.env.AGY_ACP_BIN;
  try {
    process.env.AGY_ACP_BIN = "/usr/bin/false";
    fs.rmSync(recordA, { force: true });
    const launchA = resolveLaunchSpawn(planA);
    assert.equal(spawnSync(launchA.command, [...launchA.args, "--plan-a"], { env: envA, encoding: "utf8" }).status, 0);
    assert.deepEqual(fs.readFileSync(recordA, "utf8").trimEnd().split("\n").slice(0, 2), ["acp", "--app_data_dir=antigravity-acp"]);
    assert.equal(fs.readFileSync(recordA, "utf8").trimEnd().split("\n").at(-1), "--plan-a");
    delete process.env.AGY_ACP_BIN;
    fs.rmSync(recordB, { force: true });
    const launchB = resolveLaunchSpawn(planB);
    assert.equal(spawnSync(launchB.command, [...launchB.args, "--plan-b"], { env: envB, encoding: "utf8" }).status, 0);
    assert.equal(fs.readFileSync(recordB, "utf8").trimEnd().split("\n").at(-1), "--plan-b");
  } finally {
    if (previousBin === undefined) delete process.env.AGY_ACP_BIN;
    else process.env.AGY_ACP_BIN = previousBin;
  }
}

// A direct env plan spawns its exact command and arguments.
{
  const direct = path.join(work, "direct-runtime");
  const argvRecord = path.join(work, "direct-argv.txt");
  fs.writeFileSync(direct, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvRecord}'\n`);
  fs.chmodSync(direct, 0o755);
  const env = freshEnv();
  env.AGY_ACP_BIN = direct;
  const plan = await planFor(freshStateDir(), { env });
  assert.equal(plan.source, "env");
  const launch = resolveLaunchSpawn(plan);
  assert.equal(launch.command, direct);
  assert.deepEqual(launch.args, []);
  assert.equal(spawnSync(launch.command, [...launch.args, "--direct"], { env, encoding: "utf8" }).status, 0);
  assert.equal(fs.readFileSync(argvRecord, "utf8").trimEnd(), "--direct");
  assert.equal(env.AGY_ACP_BIN, direct);
}

fs.rmSync(work, { recursive: true, force: true });
console.log("acp-runtime-source: all launch plan cases passed");
