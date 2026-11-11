// Google ships the same ACP server through two channels: the registry-signed
// runtime installed under ~/.local/opt/agy-acp, and the agy CLI, which bundles
// the server and self-updates on its own. The registry has lagged the CLI
// (Claude and GPT-OSS models arrived in the CLI's server first), so when the
// CLI on PATH is newer the adapter routes the launch through upstream's
// AGY_ACP_BIN override instead of modifying vendored code. An explicit
// AGY_ACP_BIN always wins, and every OMP process re-evaluates the choice so a
// registry release that moves back ahead reclaims the launch.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

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
  purpose: "inference" | "quota" = "inference",
  home = os.homedir(),
): { command: string; args: string[] } | undefined {
  const automaticWrapper = path.join(stateDir, "agy-acp-cli.sh");
  const configured = env.AGY_ACP_BIN?.trim();
  if (purpose === "quota" && configured && path.resolve(configured) !== path.resolve(automaticWrapper)) return undefined;
  if (purpose === "quota") {
    const managed = resolveManagedAcpCommand(home);
    if (!managed) throw new Error("Managed ACP binary is missing or not executable for quota");
    env.AGY_ACP_BIN = managed.command;
    return managed;
  }
  if (preference?.source !== "cli") return;
  const wrapper = path.join(stateDir, "agy-acp-cli.sh");
  let intact = false;
  try {
    intact = preference.cliPath !== undefined && fs.readFileSync(wrapper, "utf8") === cliWrapperScript(preference.cliPath);
  } catch {
    // Missing and unreadable wrappers fail the same launch check.
  }
  if (env.AGY_ACP_BIN !== wrapper || !isExecutableFile(wrapper) || !intact) {
    throw new Error(`Selected ACP CLI wrapper is missing, changed, not executable, or not selected by AGY_ACP_BIN: ${wrapper}`);
  }
}

export async function preferNewestAcpRuntime(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): Promise<AcpRuntimePreference> {
  const wrapper = path.join(stateDir, "agy-acp-cli.sh");
  const configured = env.AGY_ACP_BIN?.trim();
  // A wrapper written by this adapter is not a user override. A second
  // extension instance can see the first instance's AGY_ACP_BIN and must
  // recover the CLI profile instead of treating it as an explicit env runtime.
  if (configured && path.resolve(configured) === path.resolve(wrapper)) {
    const cli = await findAgyCli(env);
    if (cli) {
      const preference = { source: "cli", cliPath: cli.path, cliVersion: cli.version, managedVersion: readManagedVersion(home) } as const;
      writeCliWrapper(wrapper, cli.path);
      writeRuntimeSourceRecord(stateDir, preference);
      env.AGY_ACP_BIN = wrapper;
      return preference;
    }
    const recorded = readRuntimeSourceRecord(stateDir);
    if (recorded) return recorded;
  } else if (configured) {
    return { source: "env" };
  }
  // The generated wrapper is a POSIX shell script that upstream launches
  // directly; Windows cannot execute it, so it stays managed-only there.
  if (process.platform === "win32") return { source: "managed" };
  const cli = await findAgyCli(env);
  const managedVersion = readManagedVersion(home);
  if (!cli || (managedVersion && compareVersions(cli.version, managedVersion) <= 0)) {
    if (configured) delete env.AGY_ACP_BIN;
    return { source: "managed", cliPath: cli?.path, cliVersion: cli?.version, managedVersion };
  }
  const preference = { source: "cli", cliPath: cli.path, cliVersion: cli.version, managedVersion } as const;
  writeCliWrapper(wrapper, cli.path);
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

async function findAgyCli(env: NodeJS.ProcessEnv): Promise<{ path: string; version: string } | undefined> {
  const agy = findExecutableOnPath("agy", env) ?? findExecutableOnPath("agy.exe", env);
  if (!agy) return undefined;
  try {
    // `acp --version` both proves the subcommand exists and reports the
    // bundled server version; a CLI without it must not be selected.
    const { stdout } = await execFileAsync(agy, ["acp", "--version"], { timeout: CLI_VERSION_TIMEOUT_MS });
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

function cliWrapperScript(agyPath: string): string {
  // --app_data_dir=antigravity-acp is the managed .par's own default: the CLI
  // binary would otherwise default to antigravity-cli, mixing ACP sessions
  // with personal CLI chats outside session cleanup's tracked tree.
  return `#!/bin/sh\nif [ -n "\${OMP_ACP_DANGEROUSLY_SKIP_PERMISSIONS:-}" ]; then\n  set -- --dangerously-skip-permissions "$@"\nfi\nexec '${agyPath.replace(/'/g, "'\\''")}' acp --app_data_dir=antigravity-acp "$@"\n`;
}

function writeCliWrapper(file: string, agyPath: string): void {
  const script = cliWrapperScript(agyPath);
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
