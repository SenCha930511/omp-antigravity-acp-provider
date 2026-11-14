import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "verify-release-tarball.mjs");
const name = "omp-antigravity-acp-provider";
const version = "1.2.3";
const head = "0123456789abcdef0123456789abcdef01234567";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-tarball-check-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ name, version, gitHead: head }, null, 2)}\n`);
  const tarball = path.join(root, `${name}-${version}.tgz`);
  execFileSync("tar", ["-czf", tarball, "-C", root, "package"], { stdio: "pipe" });
  return { root, tarball };
}

function invoke(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.equal(result.error, undefined);
  return result;
}

test("accepts a matching tarball and writes GitHub env", (t) => {
  const { root, tarball } = fixture(t);
  const env = path.join(root, "github-env");
  const result = invoke(["--directory", root, "--tag", `v${version}`, "--head", head, "--github-env", env]);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /Verified omp-antigravity-acp-provider@1\.2\.3/);
  assert.equal(fs.readFileSync(env, "utf8"), `TARBALL=${tarball}\nNAME=${name}\nVERSION=${version}\n`);
});

test("rejects a tag mismatch", (t) => {
  const { root } = fixture(t);
  const result = invoke(["--directory", root, "--tag", "v9.9.9", "--head", head]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected tag/);
});

test("rejects a gitHead mismatch", (t) => {
  const { root } = fixture(t);
  const result = invoke(["--directory", root, "--tag", `v${version}`, "--head", "f".repeat(40)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected/);
});

test("rejects more than one tarball", (t) => {
  const { root, tarball } = fixture(t);
  fs.copyFileSync(tarball, path.join(root, "duplicate.tgz"));
  const result = invoke(["--directory", root, "--tag", `v${version}`, "--head", head]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly one/);
});

test("rejects unknown arguments with usage", () => {
  const result = invoke(["--unknown"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});
