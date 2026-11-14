import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { resolveCommandProbe } from "../extension/runtime/launch.ts";
import { quoteBatchArgument } from "../marketplace/antigravity-acp/provision.ts";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await fs.mkdtemp(path.join(tmpdir(), "omp-marketplace-integration-"));
const home = await fs.mkdtemp(path.join(tmpdir(), "omp-marketplace-home-"));
const profiles = path.join(home, ".omp/profiles");
await fs.mkdir(profiles, { recursive: true });
const profile = `acp-marketplace-test-${randomUUID()}`;
const profileRoot = path.join(profiles, profile);
await fs.mkdir(profileRoot);
const env = { ...process.env, HOME: home, USERPROFILE: home, OMP_PROFILE: profile,
  AGY_ACP_BIN: process.platform === "win32" ? "missing-acp-runtime.exe" : "/usr/bin/false" };
delete env.PI_CODING_AGENT_DIR;
delete env.PI_CONFIG_DIR;
const runOmp = (args, options = {}) => {
  const ompCommand = process.env.OMP_ACP_OMP_COMMAND ?? (process.platform === "win32" ? "omp.cmd" : "omp");
  const resolved = resolveCommandProbe(
    ompCommand,
    process.platform === "win32" ? args.map(quoteBatchArgument) : args,
  );
  return execute(resolved.command, resolved.args, {
    cwd: temporary,
    env,
    timeout: 300_000,
    maxBuffer: 2 * 1024 * 1024,
    ...options,
    windowsHide: true,
    windowsVerbatimArguments: process.platform === "win32",
  });
};
const command = (...args) => runOmp(args);

try {
  const source = process.argv.includes("--remote") ? "SenCha930511/omp-antigravity-acp-provider" : root;
  await command("plugin", "marketplace", "add", source);
  const discovery = await command("plugin", "discover", "sencha-plugins");
  assert.ok(discovery.stdout.includes("omp-antigravity-acp-provider"));
  console.log("Marketplace add and plugin discovery: PASS");
  await command("plugin", "install", "omp-antigravity-acp-provider@sencha-plugins");
  console.log("Marketplace install and plugin registration: PASS");
  const cold = await command("models", "antigravity-acp", "--json");
  const models = JSON.parse(cold.stdout).models;
  assert.ok(models.some(model => model.provider === "antigravity-acp"));
  console.log("First-load npm preparation and automatic OMP provider loading: PASS");

  // An invalid registry proves that a second process needs only the local cache.
  const warm = await runOmp(["models", "antigravity-acp", "--json"], {
    env: { ...env, npm_config_offline: "true", npm_config_registry: "http://127.0.0.1:1" },
    timeout: 60_000,
  });
  assert.deepEqual(JSON.parse(warm.stdout).models, models);
  console.log("Second process reuses cached adapter with npm offline: PASS");
  await command("plugin", "uninstall", "omp-antigravity-acp-provider@sencha-plugins");
  await command("plugin", "marketplace", "remove", "sencha-plugins");
  console.log("Marketplace uninstall and source removal: PASS");
} finally {
  await fs.rm(profileRoot, { recursive: true, force: true });
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
  console.log("Removed isolated OMP profile, HOME, adapter dependencies and test workspace");
}
