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

export async function preferNewestAcpRuntime(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): Promise<AcpRuntimePreference> {
  if (env.AGY_ACP_BIN?.trim()) return { source: "env" };
  // The generated wrapper is a POSIX shell script that upstream launches
  // directly; Windows cannot execute it, so it stays managed-only there.
  if (process.platform === "win32") return { source: "managed" };
  const cli = await findAgyCli(env);
  const managedVersion = readManagedVersion(home);
  if (!cli || (managedVersion && compareVersions(cli.version, managedVersion) <= 0)) {
    return { source: "managed", cliPath: cli?.path, cliVersion: cli?.version, managedVersion };
  }
  const wrapper = path.join(stateDir, "agy-acp-cli.sh");
  writeCliWrapper(wrapper, cli.path);
  env.AGY_ACP_BIN = wrapper;
  writeRuntimeSourceRecord(stateDir, { source: "cli", cliPath: cli.path, cliVersion: cli.version, managedVersion });
  return { source: "cli", cliPath: cli.path, cliVersion: cli.version, managedVersion };
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

function writeCliWrapper(file: string, agyPath: string): void {
  const script = `#!/bin/sh\nexec '${agyPath.replace(/'/g, "'\\''")}' acp "$@"\n`;
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
