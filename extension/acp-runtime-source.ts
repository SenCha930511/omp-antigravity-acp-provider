// Google ships the same ACP server through two channels: the registry-signed
// runtime installed under ~/.local/opt/agy-acp, and the agy CLI, which bundles

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { loadRuntimeSourcePreference } from "./adapter-config.ts";
import { writeJsonAtomic } from "./fs-atomic.ts";

const execFileAsync = promisify(execFile);

const CLI_VERSION_TIMEOUT_MS = 5000;

export interface AcpRuntimePreference {
  source: "env" | "cli" | "managed";
  cliPath?: string;
  cliVersion?: string;
  managedVersion?: string;
}

export type AcpRequestedPermissionMode = "default" | "auto_edit" | "yolo";

export interface AcpPermissionProfile {
  requestedMode: AcpRequestedPermissionMode;
  wireMode: "default" | "auto_edit" | "yolo" | "accept-edits";
  autoApproveProcess: boolean;
}

export type AcpQuotaSource =
  | { kind: "cli"; cliPath: string }
  | { kind: "acp"; command: string; args: string[] };

export async function resolveAcpQuotaSource(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  signal?: AbortSignal,
  preference?: AcpRuntimePreference,
): Promise<AcpQuotaSource | undefined> {
  const wrapper = cliWrapperPath(stateDir, platform);
  const configured = env.AGY_ACP_BIN?.trim();
  const configuredIsWrapper = configured !== undefined && path.resolve(configured) === path.resolve(wrapper);
  if (configured && !configuredIsWrapper) return { kind: "acp", ...resolveExplicitAcpCommand(configured, home, platform) };
  if (preference?.source === "env") return configured ? { kind: "acp", ...resolveExplicitAcpCommand(configured, home, platform) } : undefined;
  if (preference?.source === "cli") return preference.cliPath ? { kind: "cli", cliPath: preference.cliPath } : undefined;
  if (preference?.source === "managed") {
    const managed = resolveManagedAcpCommand(home, platform);
    return managed ? { kind: "acp", ...managed } : undefined;
  }
  const runtimeSource = loadRuntimeSourcePreference(stateDir);
  if (runtimeSource === "managed") {
    const managed = resolveManagedAcpCommand(home, platform);
    return managed ? { kind: "acp", ...managed } : undefined;
  }
  const recorded = configuredIsWrapper ? readRuntimeSourceRecord(stateDir) : undefined;
  const recordedCli = recorded?.cliPath !== undefined && isExecutableFile(recorded.cliPath)
    ? recorded.cliPath : undefined;
  const cli = recordedCli ?? (await findAgyCli(env, signal))?.path;
  if (cli) return { kind: "cli", cliPath: cli };
  if (runtimeSource === "cli") return undefined;
  const managed = resolveManagedAcpCommand(home, platform);
  return managed ? { kind: "acp", ...managed } : undefined;
}

export function resolveAcpPermissionProfile(
  preference: AcpRuntimePreference | undefined,
  requestedMode: AcpRequestedPermissionMode,
): AcpPermissionProfile {
  const modernCli = preference?.source === "cli" && preference.cliVersion !== undefined &&
    compareVersions(preference.cliVersion, "1.5.3") >= 0;
  return {
    requestedMode,
    wireMode: modernCli && requestedMode === "yolo" ? "default"
      : modernCli && requestedMode === "auto_edit" ? "accept-edits" : requestedMode,
    autoApproveProcess: modernCli && requestedMode === "yolo",
  };
}

function resolveExplicitAcpCommand(
  configured: string,
  home: string,
  platform: NodeJS.Platform,
): { command: string; args: string[] } {
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

export function resolveManagedAcpCommand(
  home = os.homedir(), platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } | undefined {
  const root = path.join(home, ".local", "opt", "agy-acp", "current");
  for (const name of ["agy_acp_server.par", "agy_acp_server.exe"]) {
    const command = path.join(root, name);
    if (isExecutableFile(command)) return { command, args: platform === "linux" ? ["--uid="] : [] };
  }
  return undefined;
}

export function assertSelectedAcpCliLaunch(
  stateDir: string,
  preference: AcpRuntimePreference | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } | undefined {
  if (preference?.source !== "cli") return;
  const wrapper = cliWrapperPath(stateDir, platform);
  const configured = env.AGY_ACP_BIN?.trim();
  let intact = false;
  try {
    intact = preference.cliPath !== undefined && fs.readFileSync(wrapper, "utf8") === cliWrapperScript(preference.cliPath, platform);
  } catch {
    // Missing and unreadable wrappers fail the same launch check.
  }
  if (!configured || path.resolve(configured) !== path.resolve(wrapper) || !isExecutableFile(wrapper) || !intact) {
    throw new Error(`Selected ACP CLI wrapper is missing, changed, not executable, or not selected by AGY_ACP_BIN: ${wrapper}`);
  }
}

export async function selectAcpRuntime(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): Promise<AcpRuntimePreference> {
  const wrapper = cliWrapperPath(stateDir, platform);
  const configured = env.AGY_ACP_BIN?.trim();
  const configuredIsWrapper = configured !== undefined && path.resolve(configured) === path.resolve(wrapper);
  if (configured && !configuredIsWrapper) return { source: "env" };
  const runtimeSource = loadRuntimeSourcePreference(stateDir);
  const managedVersion = readManagedVersion(home);
  if (runtimeSource === "cli") {
    if (configuredIsWrapper) delete env.AGY_ACP_BIN;
    const cli = await findAgyCli(env);
    if (!cli) throw new Error('runtimeSource is "cli" in config.json, but no usable agy CLI was found. Install the CLI or set runtimeSource to "auto".');
    return selectCli(stateDir, wrapper, env, platform, cli, managedVersion);
  }
  if (runtimeSource === "managed") {
    if (configuredIsWrapper) delete env.AGY_ACP_BIN;
    if (!resolveManagedAcpCommand(home, platform)) {
      throw new Error('runtimeSource is "managed" in config.json, but the managed ACP runtime is missing. Install it or set runtimeSource to "auto".');
    }
    return { source: "managed", managedVersion };
  }
  const cli = await findAgyCli(env);
  if (cli) {
    try {
      return selectCli(stateDir, wrapper, env, platform, cli, managedVersion);
    } catch {
      // Fall through to recorded CLI or managed runtime when wrapper persistence fails.
    }
  }
  if (configuredIsWrapper) {
    const recorded = readRuntimeSourceRecord(stateDir);
    if (recorded && isExecutableFile(recorded.cliPath)) {
      try {
        writeCliWrapper(wrapper, recorded.cliPath, platform);
        return recorded;
      } catch {
        // Fall through to managed runtime when wrapper persistence fails.
      }
    }
  }
  if (configured) delete env.AGY_ACP_BIN;
  return { source: "managed", cliPath: cli?.path, cliVersion: cli?.version, managedVersion };
}

function selectCli(
  stateDir: string,
  wrapper: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  cli: { path: string; version: string },
  managedVersion: string | undefined,
): AcpRuntimePreference {
  const preference = { source: "cli", cliPath: cli.path, cliVersion: cli.version, managedVersion } as const;
  writeCliWrapper(wrapper, cli.path, platform);
  writeRuntimeSourceRecord(stateDir, preference);
  env.AGY_ACP_BIN = wrapper;
  return preference;
}

function readRuntimeSourceRecord(stateDir: string): AcpRuntimePreference | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(stateDir, "acp-runtime-source.json"), "utf8")) as {
      source?: unknown;
      cliPath?: unknown;
      cliVersion?: unknown;
      managedVersion?: unknown;
    };
    if (value.source !== "cli" || typeof value.cliPath !== "string" || typeof value.cliVersion !== "string") return undefined;
    return {
      source: "cli",
      cliPath: value.cliPath,
      cliVersion: value.cliVersion,
      ...(typeof value.managedVersion === "string" ? { managedVersion: value.managedVersion } : {}),
    };
  } catch {
    return undefined;
  }
}

async function findAgyCli(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ path: string; version: string } | undefined> {
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
  try {
    const record = JSON.parse(
      fs.readFileSync(path.join(home, ".local", "opt", "agy-acp", "current", "install-integrity.json"), "utf8"),
    ) as { version?: unknown };
    return typeof record.version === "string" ? record.version : undefined;
  } catch {
    return undefined;
  }
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

function writeCliWrapper(file: string, agyPath: string, platform: NodeJS.Platform = process.platform): void {
  const script = cliWrapperScript(agyPath, platform);
  try {
    if (fs.readFileSync(file, "utf8") === script) return;
  } catch {
    // Absent or unreadable; write a fresh copy below.
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

function writeRuntimeSourceRecord(stateDir: string, record: AcpRuntimePreference): void {
  writeJsonAtomic(path.join(stateDir, "acp-runtime-source.json"), { ...record, decidedAt: new Date().toISOString() });
}
