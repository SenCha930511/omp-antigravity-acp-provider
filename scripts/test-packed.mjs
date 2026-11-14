import assert from "node:assert/strict";
import { mkdtemp, rm, access, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveCommandProbe } from "../extension/runtime/launch.ts";
import { quoteBatchArgument } from "../marketplace/antigravity-acp/provision.ts";

const execute = promisify(execFile);
const runNpm = (args, options) => {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const resolved = resolveCommandProbe(command, process.platform === "win32" ? args.map(quoteBatchArgument) : args);
  return execute(resolved.command, resolved.args, {
    ...options,
    windowsHide: true,
    windowsVerbatimArguments: process.platform === "win32",
  });
};
async function measureUnpackedSize(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await measureUnpackedSize(fullPath);
    else total += (await stat(fullPath)).size;
  }
  return total;
}

const tarballArgIndex = process.argv.indexOf("--tarball");
assert.ok(tarballArgIndex === -1 || Boolean(process.argv[tarballArgIndex + 1]), "--tarball requires a tarball path");
const suppliedTarball = tarballArgIndex === -1 ? undefined : path.resolve(process.argv[tarballArgIndex + 1]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "omp-acp-packed-"));
try {
  let tarballPath;
  let files;
  let packedSize;
  let unpackedSize;
  if (suppliedTarball) {
    tarballPath = suppliedTarball;
    packedSize = (await stat(tarballPath)).size;
    const listed = await execute("tar", ["-tzf", path.basename(tarballPath)], { cwd: path.dirname(tarballPath) });
    files = listed.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.endsWith("/"))
      .map(line => line.replace(/^package\//, ""));
  } else {
    const packed = JSON.parse((await runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], {
      cwd: root,
    })).stdout);
    const artifact = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
    tarballPath = path.join(temporary, artifact.filename);
    files = artifact.files.map(file => file.path);
    packedSize = artifact.size;
    unpackedSize = artifact.unpackedSize;
  }
  assert.ok(files.includes("extension/runtime.mjs"));
  assert.ok(files.includes("THIRD_PARTY_LICENSES.txt"));
  assert.ok(files.includes("extension/ambient.d.ts"));
  assert.ok(files.includes("extension/runtime.d.mts"));
  assert.ok(files.includes("extension/tool-relay-protocol.d.mts"));
  assert.ok(!files.some(file => /(?:^|\/)(?:\.env|node_modules|sessions)(?:\/|$)/.test(file)));
  console.log(`Packed ${path.basename(tarballPath)}: ${packedSize} bytes`);

  const install = path.join(temporary, "consumer");
  await runNpm(["install", "--prefix", install, tarballPath,
    "--omit=dev", "--ignore-scripts", "--legacy-peer-deps=false", "--no-audit", "--no-fund"], {
    cwd: temporary,
    timeout: 240_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const installed = path.join(install, "node_modules/omp-antigravity-acp-provider");
  const runtime = path.join(installed, "extension/runtime.mjs");
  const exports = await import(pathToFileURL(runtime).href);
  assert.equal(typeof exports.AntigravityRuntime, "function");
  // Every shipped path must be an owned adapter path: no runtime sources are
  // copied in beside the bundle, and no stray tree rides along.
  const unexpected = files.filter(file => !/^(?:extension\/|licenses\/|package\.json$|README\.md$|AGENT_INSTALL\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$|THIRD_PARTY_LICENSES\.txt$)/.test(file));
  assert.deepEqual(unexpected, [], `unexpected packed paths: ${JSON.stringify(unexpected)}`);
  await access(path.join(installed, "extension/assets/src/acp/supervisor.mjs"));
  await access(path.join(installed, "extension/assets/runtime-manifest.json"));
  assert.deepEqual((await readdir(path.join(install, "node_modules"))).filter(name => !name.startsWith(".")), ["omp-antigravity-acp-provider"]);
  unpackedSize ??= await measureUnpackedSize(installed);
  assert.ok(unpackedSize < 8 * 1024 * 1024, "Standalone adapter must stay below the tested 8 MiB package budget");
  await execute(process.execPath, [path.join(installed, "extension/assets/src/acp/supervisor.mjs"), "--command", process.execPath, "-e", "process.exit(0)"], { timeout: 10_000 });
  console.log(`Standalone install: ${unpackedSize} unpacked bytes, no production dependencies`);
  if (process.platform !== "win32") console.log("Allocated installation KiB:", (await execute("du", ["-sk", installed])).stdout.trim().split(/\s+/)[0]);
  console.log("Clean production install and portable runtime assets: PASS");

  const catalogLaunch = resolveCommandProbe(
    process.env.OMP_ACP_OMP_COMMAND ?? (process.platform === "win32" ? "omp.cmd" : "omp"),
    ["models", "antigravity-acp", "--no-extensions", "-e", path.join(installed, "extension/index.ts"), "--json"]
      .map(argument => process.platform === "win32" ? quoteBatchArgument(argument) : argument),
  );
  const catalog = await execute(catalogLaunch.command, catalogLaunch.args, {
    cwd: temporary,
    env: { ...process.env, AGY_ACP_BIN: process.execPath, GEMINI_API_KEY: "offline-fixture", HOME: temporary,
      USERPROFILE: temporary, PI_CODING_AGENT_DIR: path.join(temporary, "agent") },
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    windowsVerbatimArguments: process.platform === "win32",
  });
  assert.ok(JSON.parse(catalog.stdout).models.some(model => model.provider === "antigravity-acp"));
  console.log("Installed npm tarball loads in OMP without starting ACP: PASS");
} finally {
  await rm(temporary, { recursive: true, force: true });
  console.log("Removed temporary package and consumer installation");
}
