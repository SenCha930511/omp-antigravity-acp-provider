import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROVIDER_MODEL_SELECTOR,
  enableProviderInWhitelist,
  ensureProviderModelsEnabled,
  resolveOmpConfigPath,
} from "../extension/omp-model-whitelist.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omp-whitelist-"));
}

test("a block list gains the selector with the existing indentation and comments", () => {
  const text = [
    "# OMP agent config",
    "provider: nchc",
    "enabledModels:",
    "    - nchc/one  # primary",
    "    - \"nchc/two\"",
    "theme: dark",
    "",
  ].join("\n");
  const update = enableProviderInWhitelist(text);
  assert.equal(update.changed, true);
  assert.equal(update.reason, "updated");
  assert.deepEqual(update.entries, ["nchc/one", "nchc/two", PROVIDER_MODEL_SELECTOR]);
  assert.equal(update.text, [
    "# OMP agent config",
    "provider: nchc",
    "enabledModels:",
    "    - nchc/one  # primary",
    "    - \"nchc/two\"",
    "    - \"antigravity-acp-provider/*\"",
    "theme: dark",
    "",
  ].join("\n"));
});

test("a flow list gains the selector before the closing bracket", () => {
  const update = enableProviderInWhitelist("enabledModels: [nchc/one, \"nchc/two\"]\n");
  assert.equal(update.changed, true);
  assert.equal(update.reason, "updated");
  assert.deepEqual(update.entries, ["nchc/one", "nchc/two", PROVIDER_MODEL_SELECTOR]);
  assert.equal(update.text, "enabledModels: [nchc/one, \"nchc/two\", \"antigravity-acp-provider/*\"]\n");
});

test("a multiline flow list stays multiline", () => {
  const update = enableProviderInWhitelist("enabledModels: [\n  nchc/one,\n  nchc/two,\n]\n");
  assert.equal(update.changed, true);
  assert.equal(update.text, "enabledModels: [\n  nchc/one,\n  nchc/two, \"antigravity-acp-provider/*\"\n]\n");
});

test("an existing provider wildcard or model leaves the file unchanged", () => {
  for (const text of [
    "enabledModels:\n  - antigravity-acp-provider/*\n",
    "enabledModels: [nchc/one, \"antigravity-acp-provider/gemini-3.8-flash\"]\n",
  ]) {
    const update = enableProviderInWhitelist(text);
    assert.equal(update.changed, false);
    assert.equal(update.reason, "already-enabled");
    assert.equal(update.text, text);
  }
});

test("only a top-level enabledModels key is edited", () => {
  for (const text of [
    "provider: nchc\n",
    "provider:\n  enabledModels:\n    - nchc/one\n",
    "# enabledModels:\n#   - nchc/one\n",
  ]) {
    const update = enableProviderInWhitelist(text);
    assert.equal(update.changed, false);
    assert.equal(update.reason, "no-whitelist");
    assert.equal(update.text, text);
  }
});

test("an empty whitelist is never created or rewritten", () => {
  for (const text of ["enabledModels: []\n", "enabledModels:\nother: 1\n", "enabledModels: null\n"]) {
    const update = enableProviderInWhitelist(text);
    assert.equal(update.changed, false);
    assert.equal(update.reason, "empty-whitelist");
    assert.equal(update.text, text);
  }
});

test("CRLF endings survive the append", () => {
  const update = enableProviderInWhitelist("enabledModels:\r\n  - nchc/one\r\n");
  assert.equal(update.changed, true);
  assert.equal(update.text, "enabledModels:\r\n  - nchc/one\r\n  - \"antigravity-acp-provider/*\"\r\n");
});

test("a second pass reports the whitelist as already enabled with identical text", () => {
  const first = enableProviderInWhitelist("enabledModels:\n  - nchc/one\n");
  const second = enableProviderInWhitelist(first.text);
  assert.equal(second.changed, false);
  assert.equal(second.reason, "already-enabled");
  assert.equal(second.text, first.text);
});

test("nested or malformed whitelists are reported as unsupported and left untouched", () => {
  for (const text of [
    "enabledModels:\n  key: value\n",
    "enabledModels: [a, # note\n]\n",
    "enabledModels: [a, [b]]\n",
    "enabledModels: [a\n",
    "enabledModels: nchc/one\n",
  ]) {
    const update = enableProviderInWhitelist(text);
    assert.equal(update.changed, false);
    assert.equal(update.reason, "unsupported");
    assert.equal(update.text, text);
  }
});

test("ensureProviderModelsEnabled rewrites an existing whitelist atomically and keeps its mode", async () => {
  const dir = tempDir();
  const file = path.join(dir, "config.yml");
  fs.writeFileSync(file, "enabledModels:\n  - nchc/one\n", { mode: 0o600 });
  try {
    const update = await ensureProviderModelsEnabled(file);
    assert.equal(update.changed, true);
    assert.equal(update.reason, "updated");
    assert.equal(update.path, file);
    assert.deepEqual(update.entries, ["nchc/one", PROVIDER_MODEL_SELECTOR]);
    assert.equal(fs.readFileSync(file, "utf8"), "enabledModels:\n  - nchc/one\n  - \"antigravity-acp-provider/*\"\n");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ["config.yml"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureProviderModelsEnabled never writes a missing or already-enabled file", async () => {
  const dir = tempDir();
  const missing = path.join(dir, "config.yml");
  const enabled = path.join(dir, "config.yaml");
  fs.writeFileSync(enabled, "enabledModels:\n  - antigravity-acp-provider/*\n");
  try {
    const absent = await ensureProviderModelsEnabled(missing);
    assert.equal(absent.changed, false);
    assert.equal(absent.reason, "no-whitelist");
    assert.equal(fs.existsSync(missing), false);
    const present = await ensureProviderModelsEnabled(enabled);
    assert.equal(present.changed, false);
    assert.equal(present.reason, "already-enabled");
    assert.equal(fs.readFileSync(enabled, "utf8"), "enabledModels:\n  - antigravity-acp-provider/*\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveOmpConfigPath prefers config.yml and falls back to config.yaml", () => {
  const dir = tempDir();
  try {
    assert.equal(resolveOmpConfigPath(dir), undefined);
    const yaml = path.join(dir, "config.yaml");
    fs.writeFileSync(yaml, "enabledModels: []\n");
    assert.equal(resolveOmpConfigPath(dir), yaml);
    const yml = path.join(dir, "config.yml");
    fs.writeFileSync(yml, "enabledModels: []\n");
    assert.equal(resolveOmpConfigPath(dir), yml);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an indentless block list gains a column-zero selector", () => {
  const update = enableProviderInWhitelist("enabledModels:\n- nchc/one\nother: 1\n");
  assert.equal(update.changed, true);
  assert.equal(update.text, "enabledModels:\n- nchc/one\n- \"antigravity-acp-provider/*\"\nother: 1\n");
});

test("CRLF survives when the last item has no final newline", () => {
  const update = enableProviderInWhitelist("enabledModels:\r\n  - nchc/one");
  assert.equal(update.changed, true);
  assert.equal(update.text, "enabledModels:\r\n  - nchc/one\r\n  - \"antigravity-acp-provider/*\"");
});

test("malformed quoted scalars and unsupported YAML escapes are rejected", () => {
  for (const text of [
    "enabledModels: [\"one\" \"two\"]\n",
    "enabledModels: [\"antigravity-acp-provider\\u002f*\"]\n",
  ]) {
    const update = enableProviderInWhitelist(text);
    assert.equal(update.changed, false);
    assert.equal(update.reason, "unsupported");
    assert.equal(update.text, text);
  }
});

test("a symlinked config updates its target and keeps the link", async t => {
  const dir = tempDir();
  const target = path.join(dir, "real.yml");
  const link = path.join(dir, "config.yml");
  fs.writeFileSync(target, "enabledModels:\n  - nchc/one\n");
  try {
    fs.symlinkSync(target, link);
  } catch {
    t.skip("file symlinks are unavailable");
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  try {
    const update = await ensureProviderModelsEnabled(link);
    assert.equal(update.path, link);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(link), fs.realpathSync(target));
    assert.match(fs.readFileSync(target, "utf8"), /antigravity-acp-provider\/\*/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the original mode survives a restrictive umask", async t => {
  if (process.platform === "win32") {
    t.skip("POSIX modes only");
    return;
  }
  const dir = tempDir();
  const file = path.join(dir, "config.yml");
  fs.writeFileSync(file, "enabledModels:\n  - nchc/one\n");
  fs.chmodSync(file, 0o640);
  const previousUmask = process.umask(0o077);
  try {
    await ensureProviderModelsEnabled(file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  } finally {
    process.umask(previousUmask);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
