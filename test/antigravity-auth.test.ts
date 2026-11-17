import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ANTIGRAVITY_LOGOUT_MARKER,
  clearAntigravityCredentials,
  clearAntigravityLogoutMarker,
  inspectAntigravityAuth,
  markAntigravityLoggedOut,
  resolveAntigravityAcpDirectory,
  resolveAntigravityCliTokenPath,
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

// The marker is written first, so a logout that cannot record it leaves the
// stored credentials untouched instead of half-clearing them.
test("a logout that cannot record its marker changes nothing", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const directory = await fixture();
  try {
    const settings = path.join(directory, "settings.json");
    const token = path.join(directory, "acp_token.json");
    const original = JSON.stringify({ auth: { type: "oauth" }, keep: true });
    await fs.writeFile(settings, original);
    await fs.writeFile(token, JSON.stringify({ refresh_token: "synthetic" }));
    await fs.chmod(directory, 0o500);
    try {
      assert.throws(() => clearAntigravityCredentials(directory));
    } finally {
      await fs.chmod(directory, 0o700);
    }
    assert.equal(await fs.readFile(settings, "utf8"), original);
    assert.equal(JSON.parse(await fs.readFile(token, "utf8")).refresh_token, "synthetic");
    await assert.rejects(fs.access(path.join(directory, ANTIGRAVITY_LOGOUT_MARKER)));
  } finally {
    await fs.chmod(directory, 0o700).catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("logout records a durable marker and drops the copied CLI token", async () => {
  const directory = await fixture();
  try {
    await fs.writeFile(path.join(directory, "antigravity-oauth-token"), "cli-copy");
    await fs.writeFile(path.join(directory, "acp_token.json"), JSON.stringify({ refresh_token: "synthetic" }));
    clearAntigravityCredentials(directory);
    await assert.rejects(fs.access(path.join(directory, "antigravity-oauth-token")));
    const marker = JSON.parse(await fs.readFile(path.join(directory, ANTIGRAVITY_LOGOUT_MARKER), "utf8"));
    assert.equal(typeof marker.loggedOutAt, "string");
    const health = inspectAntigravityAuth(directory, {});
    assert.equal(health.status, "missing");
    assert.equal(health.tokenFile, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("the logout marker masks a stale settings auth choice but not a real token", async () => {
  const directory = await fixture();
  try {
    await fs.writeFile(path.join(directory, "settings.json"), JSON.stringify({ auth: { type: "oauth" }, keep: true }));
    markAntigravityLoggedOut(directory);
    const loggedOut = inspectAntigravityAuth(directory, {});
    assert.equal(loggedOut.status, "missing");
    assert.equal(loggedOut.settingsFile, true);
    await fs.writeFile(path.join(directory, "acp_token.json"), JSON.stringify({ refresh_token: "synthetic" }));
    assert.equal(inspectAntigravityAuth(directory, {}).status, "oauth-refreshable");
    clearAntigravityLogoutMarker(directory);
    await assert.rejects(fs.access(path.join(directory, ANTIGRAVITY_LOGOUT_MARKER)));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("the CLI token path follows the same home rules as the ACP tree", () => {
  const home = path.join(os.tmpdir(), "omp-cli-home");
  const suffix = path.join("antigravity-cli", "antigravity-oauth-token");
  assert.equal(resolveAntigravityCliTokenPath({ HOME: home }), path.join(home, ".gemini", suffix));
  assert.equal(resolveAntigravityCliTokenPath({ USERPROFILE: home }), path.join(home, ".gemini", suffix));
  assert.equal(resolveAntigravityCliTokenPath({ HOME: home, GEMINI_HOME: "~/g" }), path.join(home, "g", suffix));
  assert.equal(
    resolveAntigravityCliTokenPath({ HOME: home, GEMINI_HOME: path.join(home, "abs") }),
    path.join(home, "abs", suffix),
  );
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
