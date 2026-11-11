import assert from "node:assert/strict";
import { mkdtemp, rm, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "omp-acp-packed-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
try {
  const packed = JSON.parse((await execute(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], {
    cwd: root,
  })).stdout);
  const artifact = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  const files = artifact.files.map(file => file.path);
  assert.ok(files.includes("extension/runtime.mjs"));
  assert.ok(files.includes("THIRD_PARTY_LICENSES.txt"));
  assert.ok(!files.some(file => /(?:^|\/)(?:\.env|node_modules|sessions)(?:\/|$)/.test(file)));
  console.log(`Packed ${artifact.filename}: ${artifact.size} bytes`);

  const install = path.join(temporary, "consumer");
  await execute(npm, ["install", "--prefix", install, path.join(temporary, artifact.filename),
    "--omit=dev", "--ignore-scripts", "--legacy-peer-deps=false", "--no-audit", "--no-fund"], {
    cwd: temporary,
    timeout: 240_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const installed = path.join(install, "node_modules/omp-antigravity-acp-provider");
  const runtime = path.join(installed, "extension/runtime.mjs");
  const exports = await import(pathToFileURL(runtime).href);
  assert.equal(typeof exports.AntigravityRuntime, "function");
  const require = createRequire(runtime);
  assert.throws(() => require.resolve("pi-antigravity-acp-provider/package.json"), { code: "MODULE_NOT_FOUND" });
  await access(path.join(installed, "extension/assets/src/acp/supervisor.mjs"));
  await access(path.join(installed, "extension/assets/runtime-manifest.json"));
  assert.deepEqual((await readdir(path.join(install, "node_modules"))).filter(name => !name.startsWith(".")), ["omp-antigravity-acp-provider"]);
  assert.ok(artifact.unpackedSize < 8 * 1024 * 1024, "Standalone adapter must stay below the tested 8 MiB package budget");
  await execute(process.execPath, [path.join(installed, "extension/assets/src/acp/supervisor.mjs"), "--command", process.execPath, "-e", "process.exit(0)"], { timeout: 10_000 });
  console.log(`Standalone install: ${artifact.unpackedSize} unpacked bytes, no production dependencies`);
  if (process.platform !== "win32") console.log("Allocated installation KiB:", (await execute("du", ["-sk", installed])).stdout.trim().split(/\s+/)[0]);
  console.log("Clean production install and portable runtime assets: PASS");

  const catalog = await execute("omp", ["models", "antigravity-acp", "--no-extensions", "-e",
    path.join(installed, "extension/index.ts"), "--json"], {
    cwd: temporary,
    env: { ...process.env, AGY_ACP_BIN: process.execPath, GEMINI_API_KEY: "offline-fixture", HOME: temporary,
      PI_CODING_AGENT_DIR: path.join(temporary, "agent") },
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  assert.ok(JSON.parse(catalog.stdout).models.some(model => model.provider === "antigravity-acp"));
  console.log("Installed npm tarball loads in OMP without starting ACP: PASS");
} finally {
  await rm(temporary, { recursive: true, force: true });
  console.log("Removed temporary package and consumer installation");
}
