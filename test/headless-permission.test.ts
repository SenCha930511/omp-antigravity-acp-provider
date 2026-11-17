import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolvePermissionDecision, syncAntigravityOAuthToken } from "../extension/index.ts";

test("syncAntigravityOAuthToken copies token and manages directory/file modes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-token-sync-"));
  const prevGemini = process.env.GEMINI_HOME;
  delete process.env.GEMINI_HOME;

  try {
    // 1. Missing cli token -> false
    assert.equal(syncAntigravityOAuthToken(tmp), false);

    // 2. Fresh cli token -> syncs to acp directory
    const cliDir = path.join(tmp, ".gemini", "antigravity-cli");
    fs.mkdirSync(cliDir, { recursive: true });
    const cliToken = path.join(cliDir, "antigravity-oauth-token");
    fs.writeFileSync(cliToken, "TOKEN_DATA_1");

    assert.equal(syncAntigravityOAuthToken(tmp), true);
    const acpDir = path.join(tmp, ".gemini", "antigravity-acp");
    const acpToken = path.join(acpDir, "antigravity-oauth-token");
    assert.equal(fs.readFileSync(acpToken, "utf8"), "TOKEN_DATA_1");
    if (process.platform !== "win32") {
      const dirStat = fs.statSync(acpDir);
      assert.equal(dirStat.mode & 0o777, 0o700);
      const fileStat = fs.statSync(acpToken);
      assert.equal(fileStat.mode & 0o777, 0o600);
    }

    // 3. Unmodified cli token -> no copy
    assert.equal(syncAntigravityOAuthToken(tmp), false);

    // 4. Newer cli token -> copies updated data
    const future = new Date(Date.now() + 10_000);
    fs.writeFileSync(cliToken, "TOKEN_DATA_2");
    fs.utimesSync(cliToken, future, future);
    assert.equal(syncAntigravityOAuthToken(tmp), true);
    assert.equal(fs.readFileSync(acpToken, "utf8"), "TOKEN_DATA_2");

    // 5. Explicit GEMINI_HOME relocation
    const customHome = path.join(tmp, "custom-gemini");
    process.env.GEMINI_HOME = customHome;
    const future2 = new Date(Date.now() + 20_000);
    fs.utimesSync(cliToken, future2, future2);
    assert.equal(syncAntigravityOAuthToken(tmp), true);
    const customAcpToken = path.join(customHome, "antigravity-acp", "antigravity-oauth-token");
    assert.equal(fs.readFileSync(customAcpToken, "utf8"), "TOKEN_DATA_2");
  } finally {
    if (prevGemini !== undefined) process.env.GEMINI_HOME = prevGemini;
    else delete process.env.GEMINI_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolvePermissionDecision handles headless auto-approval, select, and denial", async () => {
  const request = {
    id: "req-1",
    title: "Antigravity requests write permission",
    options: [
      { id: "opt_allow_once", label: "Allow Once", kind: "allow_once" },
      { id: "opt_reject", label: "Reject", kind: "reject_once" },
    ],
  };

  // 1. Headless environment (hasUI === false) -> auto-approves allow_once
  {
    const ctx = {
      hasUI: false,
      ui: { select: async () => { throw new Error("UI select must not be called in headless mode"); } },
    };
    const decision = await resolvePermissionDecision(request, ctx);
    assert.equal(decision.optionId, "opt_allow_once");
    assert.equal(decision.cancelled, false);
    assert.equal(decision.text, "Permission: Allow Once");
  }

  // 2. UI environment without select function -> auto-approves allow_once
  {
    const ctx = { hasUI: true, ui: {} };
    const decision = await resolvePermissionDecision(request, ctx);
    assert.equal(decision.optionId, "opt_allow_once");
    assert.equal(decision.cancelled, false);
    assert.equal(decision.text, "Permission: Allow Once");
  }

  // 3. Interactive UI select returns an option
  {
    const ctx = {
      hasUI: true,
      ui: { select: async () => "Reject" },
    };
    const decision = await resolvePermissionDecision(request, ctx);
    assert.equal(decision.optionId, "opt_reject");
    assert.equal(decision.cancelled, false);
    assert.equal(decision.text, "Permission: Reject");
  }

  // 4. Interactive UI cancel (user presses Esc) -> denied, no auto-approval
  {
    const ctx = {
      hasUI: true,
      ui: { select: async () => undefined },
    };
    const decision = await resolvePermissionDecision(request, ctx);
    assert.equal(decision.optionId, undefined);
    assert.equal(decision.cancelled, true);
    assert.equal(decision.text, "Permission denied.");
  }

  // 5. Headless mode without allow option -> denied
  {
    const rejectOnlyRequest = {
      id: "req-2",
      title: "Dangerous operation",
      options: [{ id: "opt_reject", label: "Reject", kind: "reject_once" }],
    };
    const ctx = { hasUI: false };
    const decision = await resolvePermissionDecision(rejectOnlyRequest, ctx);
    assert.equal(decision.optionId, undefined);
    assert.equal(decision.cancelled, true);
    assert.equal(decision.text, "Permission denied.");
  }

  // 6. Option with allow kind or allow id fallback variants
  {
    const variants = [
      { id: "allow", label: "Allow" },
      { id: "allow_always", kind: "allow_always", label: "Always" },
      { id: "custom_id", kind: "allow", label: "Custom Allow" },
    ];
    for (const opt of variants) {
      const decision = await resolvePermissionDecision({ id: "req-3", title: "Test", options: [opt] }, { hasUI: false });
      assert.equal(decision.optionId, opt.id);
      assert.equal(decision.cancelled, false);
    }
  }
});
