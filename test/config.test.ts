import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadAdapterConfig, loadRuntimeSourcePreference, readOmpApprovalMode, resolveAdapterPermissionMode, saveAdapterPermissionMode, updateAdapterConfig } from "../extension/adapter-config.ts";
import { registerOmpAdapter } from "../extension/index.ts";
import { keychain, secretService, type OmpCommandContext } from "../extension/auth-sync.ts";
import { resolveDefaultPiConfigPath, resolveLegacyGeminiConfigPath } from "../extension/runtime/config.ts";

test("runtimeSource defaults to auto and survives permission updates", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-config-"));
  const file = path.join(directory, "config.json");
  try {
    assert.equal(loadRuntimeSourcePreference(directory), "auto");
    assert.equal(loadAdapterConfig(file).runtimeSource, "auto");
    assert.equal(loadAdapterConfig(file).permissions, "follow");
    fs.writeFileSync(file, JSON.stringify({ runtimeSource: "cli" }));
    assert.equal(loadRuntimeSourcePreference(directory), "cli");
    assert.equal(loadAdapterConfig(file).runtimeSource, "cli");
    saveAdapterPermissionMode("default", file);
    assert.equal(loadAdapterConfig(file).permissions, "default");
    assert.equal(loadAdapterConfig(file).runtimeSource, "cli");
    assert.throws(() => updateAdapterConfig(file, { runtimeSource: "invalid" } as never), /runtimeSource must be "auto", "cli", or "managed"/);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).runtimeSource, "cli", "an invalid update must not be written");
    fs.writeFileSync(file, JSON.stringify({ permissions: "invalid", runtimeSource: "cli" }));
    assert.equal(loadAdapterConfig(file).permissions, "follow");
    updateAdapterConfig(file, { runtimeSource: "auto" });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).permissions, "follow", "an invalid permission value is normalized before write");
    fs.writeFileSync(file, JSON.stringify({ runtimeSource: "invalid" }));
    assert.throws(() => loadAdapterConfig(file), /runtimeSource must be "auto", "cli", or "managed"/);
    assert.throws(() => loadRuntimeSourcePreference(directory), /runtimeSource must be "auto", "cli", or "managed"/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("follow mode reads OMP tools.approvalMode with project overrides", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-follow-permission-"));
  const agent = path.join(root, "agent");
  const project = path.join(root, "project");
  try {
    fs.mkdirSync(agent, { recursive: true });
    fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
    fs.writeFileSync(path.join(agent, "config.yml"), "tools:\n  approvalMode: yolo\n");
    assert.equal(readOmpApprovalMode(agent, project), "yolo");
    assert.equal(resolveAdapterPermissionMode("follow", agent, project), "yolo");
    assert.equal(readOmpApprovalMode(agent, project, ["omp", "--approval-mode", "write"]), "write");
    assert.equal(readOmpApprovalMode(agent, project, ["omp", "--auto-approve"]), "yolo");

    fs.writeFileSync(path.join(project, ".omp", "config.yml"), "tools:\n  approvalMode: write\n");
    assert.equal(resolveAdapterPermissionMode("follow", agent, project), "auto_edit");

    fs.writeFileSync(path.join(agent, "config.yml"), "tools: { approvalMode: 'always-ask' }\n");
    fs.rmSync(path.join(project, ".omp", "config.yml"));
    assert.equal(resolveAdapterPermissionMode("follow", agent, project), "default");

    assert.equal(resolveAdapterPermissionMode("default", agent, project), "default");
    assert.equal(resolveAdapterPermissionMode("yolo", agent, project), "yolo");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("command settings default and update without dropping unset fields", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-config-"));
  const file = path.join(directory, "config.json");
  try {
    const defaults = loadAdapterConfig(file);
    assert.equal(defaults.nativeTools, "prefer");
    assert.equal(defaults.debugToolUpdates, false);
    assert.equal(defaults.usageMode, "off");
    assert.equal(defaults.diagnostics, false);
    fs.writeFileSync(file, JSON.stringify({
      nativeTools: "disabled",
      debugToolUpdates: true,
      usageMode: "auto",
      diagnostics: true,
    }));
    const parsed = loadAdapterConfig(file);
    assert.equal(parsed.nativeTools, "disabled");
    assert.equal(parsed.debugToolUpdates, true);
    assert.equal(parsed.usageMode, "auto");
    assert.equal(parsed.diagnostics, true);
    updateAdapterConfig(file, { usageMode: "off" });
    const updated = loadAdapterConfig(file);
    assert.equal(updated.nativeTools, "disabled");
    assert.equal(updated.debugToolUpdates, true);
    assert.equal(updated.usageMode, "off");
    assert.equal(updated.diagnostics, true);
    fs.writeFileSync(file, JSON.stringify({ nativeTools: "invalid" }));
    assert.throws(() => loadAdapterConfig(file), /nativeTools must be prefer or disabled/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("adapter startup preserves permissions from either legacy config location", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-legacy-permissions-"));
  const keys = ["HOME", "PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "GEMINI_HOME"] as const;
  const previousEnv = new Map(keys.map(key => [key, process.env[key]]));
  const previousKeychain = keychain.present;
  const previousSecretPresent = secretService.present;
  const previousSecretRemove = secretService.remove;
  secretService.present = async () => false;
  secretService.remove = async () => undefined;
  for (const pathOfLegacy of [resolveDefaultPiConfigPath, resolveLegacyGeminiConfigPath]) {
    const state = path.join(root, String(pathOfLegacy.name), "agent", "antigravity-acp-provider");
    const hooks = new Map<string, (event: unknown, ctx: OmpCommandContext) => unknown>();
    let command: ((args: string, ctx: OmpCommandContext) => Promise<void>) | undefined;
    const notices: string[] = [];
    const ctx: OmpCommandContext = { ui: { notify: message => { notices.push(message); } } };
    try {
      process.env.HOME = root;
      process.env.PI_CODING_AGENT_DIR = path.dirname(state);
      delete process.env.PI_CONFIG_DIR;
      process.env.GEMINI_HOME = path.join(root, String(pathOfLegacy.name), "gemini");
      keychain.present = async () => false;
      const legacy = pathOfLegacy();
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, JSON.stringify({ permissions: "default" }));
      await registerOmpAdapter({
        on: (name, handler) => { hooks.set(name, handler); },
        registerTool() {},
        registerProvider() {},
        registerCommand: (_name, value) => { command = value.handler; },
      }, state);
      await hooks.get("session_shutdown")?.({}, ctx);
      assert.ok(command);
      await command("account", ctx);
      assert.match(notices.at(-1) ?? "", /Permission:\s+default/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(state, "config.json"), "utf8")).permissions, "default");
    } finally {
      await hooks.get("session_shutdown")?.({}, ctx).catch(() => {});
      for (const key of keys) {
        const value = previousEnv.get(key);
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      keychain.present = previousKeychain;
      secretService.present = previousSecretPresent;
      secretService.remove = previousSecretRemove;
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});
