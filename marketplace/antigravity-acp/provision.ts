import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const ADAPTER_NAME = "omp-antigravity-acp-provider";
export const ADAPTER_VERSION = "0.1.24";
const execute = promisify(execFile);
const pending = new Map<string, Promise<string>>();

function packageRoot(root: string) {
  return path.join(root, "node_modules", ADAPTER_NAME);
}

async function ready(root: string): Promise<boolean> {
  try {
    const installed = packageRoot(root);
    const metadata = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8"));
    if (metadata.name !== ADAPTER_NAME || metadata.version !== ADAPTER_VERSION) return false;
    await fs.access(path.join(installed, "extension/index.ts"));
    await fs.access(path.join(installed, "extension/runtime.mjs"));
    if (metadata.ompAcpBundle === 1) {
      await fs.access(path.join(installed, "extension/assets/src/acp/supervisor.mjs"));
      await fs.access(path.join(installed, "extension/assets/runtime-manifest.json"));
    }
    return true;
  } catch {
    return false;
  }
}

async function installPackage(destination: string): Promise<void> {
  console.error(`[${ADAPTER_NAME}] Preparing prebuilt adapter ${ADAPTER_VERSION} and dependencies (first load only)…`);
  await execute(process.platform === "win32" ? "npm.cmd" : "npm", [
    "install", "--prefix", destination, `${ADAPTER_NAME}@${ADAPTER_VERSION}`,
    "--registry=https://registry.npmjs.org/", "--save-exact", "--omit=dev",
    "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund",
  ], { timeout: 240_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
}

async function provision(cache: string, install: (directory: string) => Promise<void>): Promise<string> {
  const destination = path.join(cache, ADAPTER_VERSION);
  const entry = path.join(packageRoot(destination), "extension/index.ts");
  if (await ready(destination)) return entry;
  try {
    await fs.access(destination);
    throw new Error(`Cached ${ADAPTER_NAME} installation is incomplete. Reinstall the marketplace plugin to repair it.`);
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }

  await fs.mkdir(cache, { recursive: true });
  const staging = await fs.mkdtemp(path.join(cache, ".install-"));
  try {
    await install(staging);
    if (!await ready(staging)) throw new Error(`Downloaded ${ADAPTER_NAME} did not contain the pinned prebuilt adapter`);
    try {
      await fs.rename(staging, destination);
    } catch (error: any) {
      // Another OMP process may have finished the same immutable version first.
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code) || !await ready(destination)) throw error;
    }
    return entry;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function ensureAdapter(cache: string, install = installPackage): Promise<string> {
  const key = path.resolve(cache);
  const existing = pending.get(key);
  if (existing) return existing;
  const operation = provision(key, install);
  pending.set(key, operation);
  try {
    return await operation;
  } finally {
    if (pending.get(key) === operation) pending.delete(key);
  }
}
