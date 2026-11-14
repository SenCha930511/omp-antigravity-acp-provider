import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearAntigravityCredentials,
  inspectAntigravityAuth,
  resolveAntigravityAcpDirectory,
} from "../extension/runtime/acp/antigravity.ts";

async function fixture(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "omp-antigravity-auth-"));
}

test("a corrupt settings file no longer hides an environment API key", async () => {
  const directory = await fixture();
  try {
    await fs.writeFile(path.join(directory, "settings.json"), "{corrupt");
    const health = inspectAntigravityAuth(directory, { GEMINI_API_KEY: "synthetic-key" });
    assert.equal(health.status, "api-key-env");
    assert.equal(health.authType, "gemini-api-key");
    assert.equal(health.settingsFile, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a corrupt settings file no longer hides a refreshable token", async () => {
  const directory = await fixture();
  try {
    await fs.writeFile(path.join(directory, "settings.json"), "{corrupt");
    await fs.writeFile(path.join(directory, "acp_token.json"), JSON.stringify({ refresh_token: "synthetic" }));
    const health = inspectAntigravityAuth(directory, {});
    assert.equal(health.status, "oauth-refreshable");
    assert.equal(health.authType, "oauth-personal");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("logout removes auth without deleting unrelated settings", async () => {
  const directory = await fixture();
  try {
    await fs.writeFile(path.join(directory, "settings.json"), JSON.stringify({ auth: { type: "oauth" }, keep: true }));
    await fs.writeFile(path.join(directory, "acp_token.json"), JSON.stringify({ refresh_token: "synthetic" }));
    clearAntigravityCredentials(directory);
    await assert.rejects(fs.access(path.join(directory, "acp_token.json")));
    const settings = JSON.parse(await fs.readFile(path.join(directory, "settings.json"), "utf8"));
    assert.deepEqual(settings, { keep: true });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a corrupt settings file survives logout instead of being deleted", async () => {
  const directory = await fixture();
  try {
    const settings = path.join(directory, "settings.json");
    await fs.writeFile(settings, "{corrupt");
    clearAntigravityCredentials(directory);
    assert.equal(await fs.readFile(settings, "utf8"), "{corrupt");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a failed settings rewrite keeps the original file", { skip: process.getuid?.() === 0 }, async () => {
  const directory = await fixture();
  try {
    const settings = path.join(directory, "settings.json");
    const original = JSON.stringify({ auth: { type: "oauth" }, keep: true });
    await fs.writeFile(settings, original);
    await fs.chmod(directory, 0o500);
    try {
      clearAntigravityCredentials(directory);
    } finally {
      await fs.chmod(directory, 0o700);
    }
    assert.equal(await fs.readFile(settings, "utf8"), original);
  } finally {
    await fs.chmod(directory, 0o700).catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Windows home variables and backslash prefixes resolve consistently", () => {
  const home = path.join(os.tmpdir(), "omp-windows-home");
  assert.equal(
    resolveAntigravityAcpDirectory({ USERPROFILE: home }),
    path.join(home, ".gemini", "antigravity-acp"),
  );
  assert.equal(
    resolveAntigravityAcpDirectory({ USERPROFILE: home, GEMINI_HOME: "~\\gemini" }),
    path.join(home, "gemini", "antigravity-acp"),
  );
});
