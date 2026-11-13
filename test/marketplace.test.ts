import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ADAPTER_NAME, ADAPTER_VERSION, ensureAdapter, resolveNpmInstallCommand } from "../marketplace/antigravity-acp/provision.ts";

async function fakeInstall(directory: string) {
  const root = path.join(directory, "node_modules", ADAPTER_NAME);
  await fs.mkdir(path.join(root, "extension"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: ADAPTER_NAME, version: ADAPTER_VERSION, ompAcpBundle: 1 }));
  await fs.writeFile(path.join(root, "extension/index.ts"), "export default () => {};");
  await fs.writeFile(path.join(root, "extension/runtime.mjs"), "export {};");
  await fs.mkdir(path.join(root, "extension/assets/src/acp"), { recursive: true });
  await fs.writeFile(path.join(root, "extension/assets/src/acp/supervisor.mjs"), "export {};");
  await fs.writeFile(path.join(root, "extension/assets/runtime-manifest.json"), "{}");
}

test("Windows installation invokes npm.cmd with verbatim quoting for paths with spaces", () => {
  const destination = "C:\\Users\\Jane Doe\\cache & tools\\.install-demo";
  assert.deepEqual(resolveNpmInstallCommand(destination, "win32"), {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/e:on", "/v:off", "/c",
      `call "npm.cmd" install --prefix "C:\\Users\\Jane Doe\\cache & tools\\.install-demo" ${ADAPTER_NAME}@${ADAPTER_VERSION} --registry=https://registry.npmjs.org/ --save-exact --omit=dev --legacy-peer-deps --ignore-scripts --no-audit --no-fund`],
  });
  assert.throws(() => resolveNpmInstallCommand("C:\\bad\"path\\install", "win32"), /quotes, percent signs, or newlines/);
  assert.throws(() => resolveNpmInstallCommand("C:\\Users\\%cache%\\install", "win32"), /percent signs/);
  assert.deepEqual(resolveNpmInstallCommand(destination, "linux"), {
    command: "npm",
    args: [
      "install", "--prefix", destination, `${ADAPTER_NAME}@${ADAPTER_VERSION}`,
      "--registry=https://registry.npmjs.org/", "--save-exact", "--omit=dev",
      "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund",
    ],
  });
});

test("marketplace provision shares concurrent work and warm loads stay offline", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "omp-marketplace-unit-"));
  try {
    let installs = 0;
    const install = async (directory: string) => { installs++; await fakeInstall(directory); };
    const [first, second] = await Promise.all([ensureAdapter(root, install), ensureAdapter(root, install)]);
    assert.equal(first, second);
    assert.equal(installs, 1);
    assert.equal(await ensureAdapter(root, async () => { throw Error("unexpected network"); }), first);
    assert.deepEqual(await fs.readdir(root), [ADAPTER_VERSION]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("failed marketplace preparation is cleaned and can be retried", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "omp-marketplace-unit-"));
  try {
    await assert.rejects(ensureAdapter(root, async () => { throw Error("offline"); }), /offline/);
    assert.deepEqual(await fs.readdir(root), []);
    await ensureAdapter(root, fakeInstall);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("standalone cache with missing supervisor assets is rejected without running npm", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "omp-marketplace-unit-"));
  try {
    await ensureAdapter(root, fakeInstall);
    await fs.rm(path.join(root, ADAPTER_VERSION, "node_modules", ADAPTER_NAME, "extension/assets/src/acp/supervisor.mjs"));
    await assert.rejects(ensureAdapter(root, async () => { throw Error("must stay offline"); }), /incomplete/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("missing prebuilt content is not promoted into the cache", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "omp-marketplace-unit-"));
  try {
    await assert.rejects(ensureAdapter(root, async () => {}), /pinned prebuilt adapter/);
    assert.deepEqual(await fs.readdir(root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
