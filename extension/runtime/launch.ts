// Google ships the same ACP server through two channels: the registry-signed
// runtime installed under ~/.local/opt/agy-acp, and the agy CLI, which bundles
// a newer server behind its `acp` subcommand. This module resolves one
// immutable launch plan per adapter instance: the exact spawn target, the
// managed-install decision, and the quota channel.
//
// `AGY_ACP_BIN` is only ever read. Spawning uses the plan's target, so a later
// change to shared process state cannot redirect an already selected runtime.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { loadRuntimeSourcePreference } from "../adapter-config.ts";
import { writeJsonAtomic } from "../fs-atomic.ts";

const execFileAsync = promisify(execFile);

const CLI_VERSION_TIMEOUT_MS = 5000;
const RUNTIME_SOURCE_RECORD = "acp-runtime-source.json";

export type DirectCommand = { command: string; args: readonly string[] };

// A CLI plan must spawn the validated wrapper, never a bare command string.
export type SpawnTarget =
  | { kind: "direct"; value: DirectCommand }
  | { kind: "wrapper"; path: string; sha256: string };

export type RuntimeLaunchSource = "env" | "cli" | "managed";

export type LaunchQuota =
  | { kind: "cli"; cliPath: string }
  | { kind: "acp"; value: DirectCommand }
  | { kind: "none" };

export interface RuntimeLaunchPlan {
  source: RuntimeLaunchSource;
  /**
   * Absent only while `installManaged` still has to install the managed
   * runtime: every other plan carries the exact spawn target.
   */
  target?: SpawnTarget;
  // Derived from this plan, never rediscovered from another source.
  quota: LaunchQuota;
  // True when `runtimeSource: "auto"` selected the managed channel, so the
  // adapter may install it or check for runtime updates.
  installManaged: boolean;
  cliPath?: string;
  cliVersion?: string;
  managedVersion?: string;
}

// The runtime-facing quota record: a CLI print-mode command or a short-lived
// ACP session against one exact command.
export type AcpQuotaSource =
  | { kind: "cli"; cliPath: string }
  | { kind: "acp"; command: string; args: readonly string[] };

export type AcpRequestedPermissionMode = "default" | "auto_edit" | "yolo";

export interface AcpPermissionProfile {
  requestedMode: AcpRequestedPermissionMode;
  wireMode: "default" | "auto_edit" | "yolo" | "accept-edits";
  autoApproveProcess: boolean;
}

// Permission mapping only needs the channel and the CLI version it reports.
export type PermissionPlan = Pick<RuntimeLaunchPlan, "source" | "cliVersion">;

export interface LaunchOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
}

interface AgyCli {
  path: string;
  version: string;
}

interface RecordedCliRuntime {
  cliPath: string;
  cliVersion: string;
  managedVersion?: string;
}

// Resolve the launch plan the adapter will spawn. This writes the CLI wrapper
// and the recorded decision when the CLI channel is selected.
export function resolveRuntimeLaunchPlan(stateDir: string, options: LaunchOptions = {}): Promise<RuntimeLaunchPlan> {
  return buildLaunchPlan(stateDir, options, true);
}

// Resolve the same order without writing the wrapper or the recorded decision.
// Quota display and diagnostics must stay read-only.
export function inspectRuntimeLaunchPlan(stateDir: string, options: LaunchOptions = {}): Promise<RuntimeLaunchPlan> {
  return buildLaunchPlan(stateDir, options, false);
}

export function quotaSourceForPlan(plan: RuntimeLaunchPlan): AcpQuotaSource | undefined {
  if (plan.quota.kind === "cli") return { kind: "cli", cliPath: plan.quota.cliPath };
  if (plan.quota.kind === "acp") return { kind: "acp", command: plan.quota.value.command, args: plan.quota.value.args };
  return undefined;
}

export function resolveAcpPermissionProfile(
  plan: PermissionPlan | undefined,
  requestedMode: AcpRequestedPermissionMode,
): AcpPermissionProfile {
  const modernCli = plan?.source === "cli" && plan.cliVersion !== undefined &&
    compareVersions(plan.cliVersion, "1.5.3") >= 0;
  return {
    requestedMode,
    wireMode: modernCli && requestedMode === "yolo" ? "default"
      : modernCli && requestedMode === "auto_edit" ? "accept-edits" : requestedMode,
    autoApproveProcess: modernCli && requestedMode === "yolo",
  };
}

// Turn the plan's target into the exact command the supervisor spawns. A CLI
// wrapper is verified against the selected sha256 and the executable bit first,
// so a tampered or replaced wrapper never runs. The wrapper path itself is the
// spawned target: the supervisor owns the Windows batch wrapping.
export function resolveLaunchTarget(plan: RuntimeLaunchPlan): DirectCommand {
  const target = plan.target;
  if (!target) {
    throw new Error(`No ACP runtime is installed for the ${plan.source} source. Install the managed runtime or provide a usable agy CLI.`);
  }
  if (target.kind === "direct") return target.value;
  let actual: string;
  try {
    actual = sha256File(target.path);
  } catch {
    throw new Error(`Selected ACP CLI wrapper is missing: ${target.path}`);
  }
  if (actual !== target.sha256) throw new Error(`Selected ACP CLI wrapper changed after selection: ${target.path}`);
  if (!isExecutableFile(target.path)) throw new Error(`Selected ACP CLI wrapper is not executable: ${target.path}`);
  return { command: target.path, args: [] };
}

// The same verified target in the form a direct spawn needs. Windows cannot
// spawn a .cmd file without the command processor, so a direct caller gets the
// cmd wrapper explicitly; plan-driven spawning uses `resolveLaunchTarget` and
// leaves that to the supervisor.
export function resolveLaunchSpawn(
  plan: RuntimeLaunchPlan,
  platform: NodeJS.Platform = process.platform,
): DirectCommand {
  const target = resolveLaunchTarget(plan);
  if (plan.target?.kind !== "wrapper") return target;
  return wrapperCommand(target.command, platform);
}

export function resolveManagedAcpCommand(
  home = os.homedir(), platform: NodeJS.Platform = process.platform,
): DirectCommand | undefined {
  const root = path.join(home, ".local", "opt", "agy-acp", "current");
  for (const name of ["agy_acp_server.par", "agy_acp_server.exe"]) {
    const command = path.join(root, name);
    if (isExecutableFile(command)) return { command, args: platform === "linux" ? ["--uid="] : [] };
  }
  return undefined;
}

async function buildLaunchPlan(
  stateDir: string,
  options: LaunchOptions,
  persist: boolean,
): Promise<RuntimeLaunchPlan> {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const wrapper = cliWrapperPath(stateDir, platform);
  const configured = env.AGY_ACP_BIN?.trim();
  // A wrapper generated by this adapter is not a user override: it is the
  // adapter's own recorded CLI decision, so selection continues below.
  const configuredIsWrapper = configured !== undefined && path.resolve(configured) === path.resolve(wrapper);
  if (configured && !configuredIsWrapper) {
    const command = explicitAcpCommand(configured, home, platform);
    return {
      source: "env",
      target: { kind: "direct", value: command },
      quota: { kind: "acp", value: command },
      installManaged: false,
    };
  }
  const runtimeSource = loadRuntimeSourcePreference(stateDir);
  const managedVersion = readManagedVersion(home);
  if (runtimeSource === "cli") {
    const cli = await findAgyCli(env, options.signal);
    if (!cli) throw new Error('runtimeSource is "cli" in config.json, but no usable agy CLI was found. Install the CLI or set runtimeSource to "auto".');
    return cliPlan(stateDir, platform, cli, managedVersion, persist);
  }
  if (runtimeSource === "managed") {
    const managed = resolveManagedAcpCommand(home, platform);
    if (!managed) throw new Error('runtimeSource is "managed" in config.json, but the managed ACP runtime is missing. Install it or set runtimeSource to "auto".');
    return managedPlan(managed, managedVersion);
  }
  const cli = await findAgyCli(env, options.signal);
  if (cli) {
    try {
      return cliPlan(stateDir, platform, cli, managedVersion, persist);
    } catch {
      // Fall through to the recorded CLI or the managed runtime when wrapper persistence fails.
    }
  }
  if (configuredIsWrapper) {
    const recorded = readRuntimeSourceRecord(stateDir);
    if (recorded && isExecutableFile(recorded.cliPath)) {
      try {
        return cliPlan(stateDir, platform, { path: recorded.cliPath, version: recorded.cliVersion }, managedVersion, persist);
      } catch {
        // Fall through to the managed runtime when wrapper persistence fails.
      }
    }
  }
  const managed = resolveManagedAcpCommand(home, platform);
  return {
    source: "managed",
    ...(managed
      ? { target: { kind: "direct", value: managed }, quota: { kind: "acp", value: managed } }
      : { quota: { kind: "none" } }),
    installManaged: true,
    ...(cli ? { cliPath: cli.path, cliVersion: cli.version } : {}),
    ...(managedVersion !== undefined ? { managedVersion } : {}),
  };
}

function cliPlan(
  stateDir: string,
  platform: NodeJS.Platform,
  cli: AgyCli,
  managedVersion: string | undefined,
  persist: boolean,
): RuntimeLaunchPlan {
  const wrapper = cliWrapperPath(stateDir, platform);
  const script = cliWrapperScript(cli.path, platform);
  const sha256 = sha256Text(script);
  if (persist) {
    writeCliWrapper(wrapper, script);
    writeRuntimeSourceRecord(stateDir, {
      source: "cli",
      cliPath: cli.path,
      cliVersion: cli.version,
      ...(managedVersion !== undefined ? { managedVersion } : {}),
    });
  }
  return {
    source: "cli",
    target: { kind: "wrapper", path: wrapper, sha256 },
    quota: { kind: "cli", cliPath: cli.path },
    installManaged: false,
    cliPath: cli.path,
    cliVersion: cli.version,
    ...(managedVersion !== undefined ? { managedVersion } : {}),
  };
}

function managedPlan(managed: DirectCommand, managedVersion: string | undefined): RuntimeLaunchPlan {
  return {
    source: "managed",
    target: { kind: "direct", value: managed },
    quota: { kind: "acp", value: managed },
    installManaged: false,
    ...(managedVersion !== undefined ? { managedVersion } : {}),
  };
}

function explicitAcpCommand(
  configured: string,
  home: string,
  platform: NodeJS.Platform,
): DirectCommand {
  const command = configured === "~" ? home
    : configured.startsWith("~/") ? path.join(home, configured.slice(2)) : configured;
  if (platform !== "linux") return { command, args: [] };
  try {
    const fd = fs.openSync(command, "r");
    try {
      const prefix = Buffer.alloc(2);
      const count = fs.readSync(fd, prefix, 0, prefix.length, 0);
      return { command, args: prefix.subarray(0, count).toString("utf8") === "#!" ? [] : ["--uid="] };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { command, args: [] };
  }
}

function readRuntimeSourceRecord(stateDir: string): RecordedCliRuntime | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(stateDir, RUNTIME_SOURCE_RECORD), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const source = "source" in parsed ? parsed.source : undefined;
  const cliPath = "cliPath" in parsed ? parsed.cliPath : undefined;
  const cliVersion = "cliVersion" in parsed ? parsed.cliVersion : undefined;
  if (source !== "cli" || typeof cliPath !== "string" || !cliPath) return undefined;
  if (typeof cliVersion !== "string" || !cliVersion) return undefined;
  const managedVersion = "managedVersion" in parsed ? parsed.managedVersion : undefined;
  return {
    cliPath,
    cliVersion,
    ...(typeof managedVersion === "string" ? { managedVersion } : {}),
  };
}

async function findAgyCli(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<AgyCli | undefined> {
  const agy = findExecutableOnPath("agy", env) ?? findExecutableOnPath("agy.exe", env);
  if (!agy) return undefined;
  try {
    // `acp --version` both proves the subcommand exists and reports the
    // bundled server version; a CLI without it must not be selected.
    const { stdout } = await execFileAsync(agy, ["acp", "--version"], {
      timeout: CLI_VERSION_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    const version = /\d+\.\d+\.\d+/.exec(stdout)?.[0];
    return version ? { path: agy, version } : undefined;
  } catch {
    return undefined;
  }
}

function findExecutableOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function readManagedVersion(home: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(home, ".local", "opt", "agy-acp", "current", "install-integrity.json"), "utf8"),
    );
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const version = "version" in parsed ? parsed.version : undefined;
  return typeof version === "string" ? version : undefined;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(".").map(part => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function cliWrapperPath(stateDir: string, platform: NodeJS.Platform): string {
  return path.join(stateDir, platform === "win32" ? "agy-acp-cli.cmd" : "agy-acp-cli.sh");
}

function wrapperCommand(file: string, platform: NodeJS.Platform): DirectCommand {
  if (platform !== "win32") return { command: file, args: [] };
  // Node cannot spawn a .cmd file without a shell, so hand the exact wrapper
  // path to the command processor.
  return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `call "${file}"`] };
}

function cliWrapperScript(agyPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const escaped = agyPath.replace(/%/g, "%%");
    return `@echo off\r\nsetlocal\r\nset "OMP_ACP_EXTRA="\r\nif "%OMP_ACP_DANGEROUSLY_SKIP_PERMISSIONS%"=="1" set "OMP_ACP_EXTRA=--dangerously-skip-permissions"\r\n"${escaped}" acp --app_data_dir=antigravity-acp %OMP_ACP_EXTRA% %*\r\nexit /b %ERRORLEVEL%\r\n`;
  }
  // --app_data_dir=antigravity-acp is the managed .par's own default: the CLI
  // binary would otherwise default to antigravity-cli, mixing ACP sessions
  // with personal CLI chats outside session cleanup's tracked tree.
  return `#!/bin/sh\nif [ "\${OMP_ACP_DANGEROUSLY_SKIP_PERMISSIONS:-}" = "1" ]; then\n  set -- --dangerously-skip-permissions "$@"\nfi\nexec '${agyPath.replace(/'/g, "'\\''")}' acp --app_data_dir=antigravity-acp "$@"\n`;
}

export function writeCliWrapper(file: string, script: string): void {
  let existing: string | undefined;
  try { existing = fs.readFileSync(file, "utf8"); } catch { /* Absent or unreadable. */ }
  if (existing === script) {
    // Repeated selection must converge on an executable wrapper even when only
    // the mode was damaged. A chmod/stat failure still fails closed here or in
    // resolveLaunchTarget rather than silently launching a non-executable file.
    if (process.platform !== "win32" && (fs.statSync(file).mode & 0o111) !== 0o111) fs.chmodSync(file, 0o755);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, script, { mode: 0o755 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeRuntimeSourceRecord(
  stateDir: string,
  record: { source: "cli"; cliPath: string; cliVersion: string; managedVersion?: string },
): void {
  writeJsonAtomic(path.join(stateDir, RUNTIME_SOURCE_RECORD), { ...record, decidedAt: new Date().toISOString() });
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
