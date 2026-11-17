import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolvePermissionDecision, syncAntigravityOAuthToken } from "../extension/index.ts";
import {
  ANTIGRAVITY_LOGOUT_MARKER,
  clearAntigravityCredentials,
  clearAntigravityLogoutMarker,
  inspectAntigravityAuth,
} from "../extension/runtime/acp/antigravity.ts";

function fixture(): { root: string; home: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-token-sync-"));
  return { root, home: path.join(root, "home") };
}

function writeToken(file: string, data: string, mtime?: Date): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

test("syncAntigravityOAuthToken copies the CLI token atomically into the ACP tree", () => {
  const { root, home } = fixture();
  const env = { HOME: home };
  const cliToken = path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
  const acpDir = path.join(home, ".gemini", "antigravity-acp");
  const acpToken = path.join(acpDir, "antigravity-oauth-token");
  try {
    // 1. Missing cli token -> false
    assert.equal(syncAntigravityOAuthToken(env), false);

    // 2. Fresh cli token -> syncs to acp directory
    writeToken(cliToken, "TOKEN_DATA_1");
    assert.equal(syncAntigravityOAuthToken(env), true);
    assert.equal(fs.readFileSync(acpToken, "utf8"), "TOKEN_DATA_1");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(acpDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(acpToken).mode & 0o777, 0o600);
    }
    // The rename leaves no temporary copy behind.
    assert.deepEqual(fs.readdirSync(acpDir).filter(name => name.endsWith(".tmp")), []);

    // 3. Unmodified cli token -> no copy
    assert.equal(syncAntigravityOAuthToken(env), false);

    // 4. Newer cli token -> copies updated data
    writeToken(cliToken, "TOKEN_DATA_2", new Date(Date.now() + 10_000));
    assert.equal(syncAntigravityOAuthToken(env), true);
    assert.equal(fs.readFileSync(acpToken, "utf8"), "TOKEN_DATA_2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit GEMINI_HOME owns both the CLI source and the ACP target", () => {
  const { root, home } = fixture();
  const geminiHome = path.join(root, "custom-gemini");
  const env = { HOME: home, GEMINI_HOME: geminiHome };
  try {
    // The personal CLI login must never be the source once GEMINI_HOME is set.
    writeToken(path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "PERSONAL_TOKEN");
    writeToken(path.join(geminiHome, "antigravity-cli", "antigravity-oauth-token"), "ISOLATED_TOKEN");
    assert.equal(syncAntigravityOAuthToken(env), true);
    assert.equal(fs.readFileSync(path.join(geminiHome, "antigravity-acp", "antigravity-oauth-token"), "utf8"), "ISOLATED_TOKEN");
    assert.equal(fs.existsSync(path.join(home, ".gemini", "antigravity-acp")), false);

    // A relative `~` form resolves against the effective home, like the ACP tree.
    const tildeEnv = { HOME: home, GEMINI_HOME: "~/.gemini-alt" };
    writeToken(path.join(home, ".gemini-alt", "antigravity-cli", "antigravity-oauth-token"), "TILDE_TOKEN");
    assert.equal(syncAntigravityOAuthToken(tildeEnv), true);
    assert.equal(fs.readFileSync(path.join(home, ".gemini-alt", "antigravity-acp", "antigravity-oauth-token"), "utf8"), "TILDE_TOKEN");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a recorded logout keeps the token sync from restoring the CLI login", () => {
  const { root, home } = fixture();
  const env = { HOME: home };
  const cliToken = path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
  const acpDir = path.join(home, ".gemini", "antigravity-acp");
  const acpToken = path.join(acpDir, "antigravity-oauth-token");
  try {
    writeToken(cliToken, "TOKEN_DATA");
    assert.equal(syncAntigravityOAuthToken(env), true);
    assert.equal(fs.readFileSync(acpToken, "utf8"), "TOKEN_DATA");

    // Logout removes the copied token, keeps the personal CLI token, and records
    // the marker that blocks every later sync.
    clearAntigravityCredentials(acpDir);
    assert.equal(fs.existsSync(path.join(acpDir, ANTIGRAVITY_LOGOUT_MARKER)), true);
    assert.equal(fs.existsSync(acpToken), false);
    assert.equal(fs.readFileSync(cliToken, "utf8"), "TOKEN_DATA");
    assert.equal(inspectAntigravityAuth(acpDir, {}).status, "missing");

    writeToken(cliToken, "TOKEN_AFTER_LOGOUT", new Date(Date.now() + 60_000));
    assert.equal(syncAntigravityOAuthToken(env), false);
    assert.equal(fs.existsSync(acpToken), false);

    // A successful fresh login clears the marker, so the sync resumes.
    clearAntigravityLogoutMarker(acpDir);
    assert.equal(syncAntigravityOAuthToken(env), true);
    assert.equal(fs.readFileSync(acpToken, "utf8"), "TOKEN_AFTER_LOGOUT");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a logout marker written during the token rename wins over the copy", () => {
  const { root, home } = fixture();
  const env = { HOME: home };
  const cliToken = path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
  const acpDir = path.join(home, ".gemini", "antigravity-acp");
  const acpToken = path.join(acpDir, "antigravity-oauth-token");
  const marker = path.join(acpDir, ANTIGRAVITY_LOGOUT_MARKER);
  writeToken(cliToken, "TOKEN_DURING_LOGOUT");
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (!injected && String(to).endsWith("antigravity-oauth-token")) {
      fs.mkdirSync(acpDir, { recursive: true });
      fs.writeFileSync(marker, "{}\n");
      injected = true;
    }
    return originalRename(from, to);
  }) as typeof fs.renameSync;
  try {
    assert.equal(syncAntigravityOAuthToken(env), false);
    assert.equal(injected, true);
    assert.equal(fs.existsSync(acpToken), false, "the marker must remove the raced copy");
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const request = {
  id: "req-1",
  title: "Antigravity requests write permission",
  options: [
    { id: "opt_allow_once", label: "Allow Once", kind: "allow_once" },
    { id: "opt_reject", label: "Reject", kind: "reject_once" },
  ],
};

test("resolvePermissionDecision only auto-approves headless prompts in an auto-approving mode", async () => {
  // 1. Headless + auto_edit -> auto-approves allow_once without asking
  {
    const ctx = {
      hasUI: false,
      ui: { select: async () => { throw new Error("UI select must not be called in headless mode"); } },
    };
    const decision = await resolvePermissionDecision(request, ctx, "auto_edit");
    assert.equal(decision.optionId, "opt_allow_once");
    assert.equal(decision.cancelled, false);
    assert.equal(decision.text, "Permission: Allow Once");
  }

  // 2. Headless + yolo -> auto-approves allow_once
  assert.equal((await resolvePermissionDecision(request, { hasUI: false }, "yolo")).optionId, "opt_allow_once");

  // 3. Headless + default -> denied, because the effective mode never trusted the agent
  {
    const decision = await resolvePermissionDecision(request, { hasUI: false }, "default");
    assert.equal(decision.optionId, undefined);
    assert.equal(decision.cancelled, true);
    assert.equal(decision.text, "Permission denied.");
  }

  // 4. UI without a select function is equally unable to ask; default still denies
  assert.equal((await resolvePermissionDecision(request, { hasUI: true, ui: {} }, "default")).cancelled, true);
  assert.equal((await resolvePermissionDecision(request, { hasUI: true, ui: {} }, "yolo")).optionId, "opt_allow_once");

  // 5. Interactive UI select returns an option, regardless of the mode
  {
    const ctx = { hasUI: true, ui: { select: async () => "Reject" } };
    const decision = await resolvePermissionDecision(request, ctx, "default");
    assert.equal(decision.optionId, "opt_reject");
    assert.equal(decision.cancelled, false);
    assert.equal(decision.text, "Permission: Reject");
  }

  // 6. Interactive UI cancel (user presses Esc) -> denied, no auto-approval
  {
    const ctx = { hasUI: true, ui: { select: async () => undefined } };
    const decision = await resolvePermissionDecision(request, ctx, "yolo");
    assert.equal(decision.optionId, undefined);
    assert.equal(decision.cancelled, true);
    assert.equal(decision.text, "Permission denied.");
  }

  // 7. Headless mode without allow option -> denied
  {
    const rejectOnlyRequest = {
      id: "req-2",
      title: "Dangerous operation",
      options: [{ id: "opt_reject", label: "Reject", kind: "reject_once" }],
    };
    const decision = await resolvePermissionDecision(rejectOnlyRequest, { hasUI: false }, "yolo");
    assert.equal(decision.optionId, undefined);
    assert.equal(decision.cancelled, true);
    assert.equal(decision.text, "Permission denied.");
  }

  // 8. Option with allow kind or allow id fallback variants
  {
    const variants = [
      { id: "allow", label: "Allow" },
      { id: "allow_always", kind: "allow_always", label: "Always" },
      { id: "custom_id", kind: "allow", label: "Custom Allow" },
    ];
    for (const opt of variants) {
      const decision = await resolvePermissionDecision({ id: "req-3", title: "Test", options: [opt] }, { hasUI: false }, "auto_edit");
      assert.equal(decision.optionId, opt.id);
      assert.equal(decision.cancelled, false);
    }
  }
});

test("headless auto-approval prefers a one-shot grant over a lasting one", async () => {
  const alwaysFirst = {
    id: "req-4",
    title: "Write",
    options: [
      { id: "opt_always", label: "Always Allow", kind: "allow_always" },
      { id: "opt_once", label: "Allow Once", kind: "allow_once" },
      { id: "opt_generic", label: "Allow", kind: "allow" },
    ],
  };
  assert.equal((await resolvePermissionDecision(alwaysFirst, { hasUI: false }, "yolo")).optionId, "opt_once");

  // Without a one-shot option the lasting grant beats an unclassified allow.
  const noOnce = {
    id: "req-5",
    title: "Write",
    options: [
      { id: "opt_generic", label: "Allow", kind: "allow" },
      { id: "opt_always", label: "Always Allow", kind: "allow_always" },
    ],
  };
  assert.equal((await resolvePermissionDecision(noOnce, { hasUI: false }, "auto_edit")).optionId, "opt_always");
});
