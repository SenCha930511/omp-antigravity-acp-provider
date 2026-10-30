import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAntigravityCommandHandler, type CommandControllerDeps, type RuntimeBundleView } from "../extension/commands.ts";
import type { OmpCommandContext } from "../extension/auth-sync.ts";
import { SessionCleanup } from "../extension/session-cleanup.ts";

const bundle: RuntimeBundleView = {
  runtime: {
    snapshot: async () => ({ bindings: 0, permissionMode: "yolo", metrics: {}, processes: [] }),
    setPermissionMode: async () => {},
    logout: async () => {},
    close: async () => {},
    getPermission: () => undefined,
  },
  provider: {
    auth: { oauth: { login: async () => ({}), refresh: async () => ({}) } },
    streamSimple: () => (async function* () {})(),
  },
  isBusy: () => false,
};

function makeHandler() {
  let runtimeCreates = 0;
  const state = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omp-commands-")));
  const notices: string[] = [];
  const deps: CommandControllerDeps = {
    configPath: path.join(state, "config.json"),
    contextPath: path.join(state, "context.json"),
    toolPolicyPath: path.join(state, "omp-tools.json"),
    cleanup: { status: () => ({ mode: "off", idleDays: 7, file: "", scope: "" }), configure() {}, start() {}, stop() {} } as CommandControllerDeps["cleanup"],
    connections: new Set(),
    auth: { watchOmpCredentials() {} } as CommandControllerDeps["auth"],
    catalog: { refresh: async () => [], currentModels: [] } as unknown as CommandControllerDeps["catalog"],
    prepareRuntime: async () => {},
    getContextSettings: () => ({ defaults: {}, models: {} }),
    setContextSettings: () => {},
    getToolPolicy: () => ({ nativeTools: "prefer", debugToolUpdates: false }),
    setToolPolicy: () => {},
    setPermissionModeState: () => {},
    getLastToolAudit: () => undefined,
    getRuntimeForSession: () => { runtimeCreates++; return bundle; },
    peekRuntimeForSession: () => undefined,
    getSavedSessionCount: () => 0,
    getPermissionMode: () => "default",
    getAllRuntimes: () => [],
    closeAllRuntimes: async () => {},
    onModelsUpdated: () => {},
  };
  const ctx = { ui: { notify: (text: string) => notices.push(text) } } as OmpCommandContext;
  return {
    handler: createAntigravityCommandHandler(deps),
    ctx,
    notices,
    state,
    deps,
    runtimeCreates: () => runtimeCreates,
  };
}

test("balanced cleanup command persists retention and accepts custom days without starting a model", async t => {
  const f = makeHandler(), acp = path.join(fs.realpathSync(f.state), "acp");
  fs.mkdirSync(acp);
  const cleanup = new SessionCleanup(fs.realpathSync(f.state), acp);
  f.deps.cleanup = cleanup;
  t.after(async () => { await cleanup.stop(); fs.rmSync(f.state, { recursive: true, force: true }); });
  await f.handler("cleanup balanced", f.ctx);
  let report = JSON.parse(f.notices.at(-1)!);
  assert.equal(report.mode, "balanced"); assert.equal(report.idleDays, 7); assert.equal(report.recoveryDays, 1);
  assert.equal(report.maxBytes, 512 * 1024 * 1024);
  await f.handler("cleanup balanced 14", f.ctx);
  report = JSON.parse(f.notices.at(-1)!); assert.equal(report.idleDays, 14);
  const before = fs.readFileSync(cleanup.policyPath, "utf8");
  for (const input of ["cleanup balanced 0", "cleanup balanced nope", "cleanup balanced 7 extra", "cleanup conservative 7"]) {
    await assert.rejects(f.handler(input, f.ctx));
    assert.equal(fs.readFileSync(cleanup.policyPath, "utf8"), before);
  }
  assert.equal(f.runtimeCreates(), 0);
});

test("usage, account and refresh report without instantiating a runtime", async () => {
  const fixture = makeHandler();
  await fixture.handler("usage", fixture.ctx);
  assert.match(fixture.notices[0]!, /"configured"/);
  await fixture.handler("account", fixture.ctx);
  const account = fixture.notices[1]!;
  assert.match(account, /Antigravity ACP account/);
  assert.match(account, /Saved ACP sessions: 0/);
  assert.match(account, /Requested permission mode: default/);
  assert.match(account, /Active bindings: 0/);
  await fixture.handler("refresh", fixture.ctx);
  assert.match(fixture.notices[2]!, /Refreshed ACP model cache/);
  assert.equal(fixture.runtimeCreates(), 0);
  fs.rmSync(fixture.state, { recursive: true, force: true });
});

test("unknown subcommands and stray arguments fail with usage errors, not a runtime", async () => {
  const fixture = makeHandler();
  await assert.rejects(fixture.handler("unknown", fixture.ctx), /Usage: \/antigravity-acp \[status\|account\|/);
  await assert.rejects(fixture.handler("permissions invalid", fixture.ctx), /Usage: \/antigravity-acp permissions default\|auto-edit\|yolo/);
  await assert.rejects(fixture.handler("permissions", fixture.ctx), /Usage: \/antigravity-acp permissions/);
  await assert.rejects(fixture.handler("permissions default extra", fixture.ctx), /Usage: \/antigravity-acp permissions/);
  await assert.rejects(fixture.handler("refresh extra", fixture.ctx), /Usage: \/antigravity-acp refresh/);
  await assert.rejects(fixture.handler("tools extra", fixture.ctx), /Usage: \/antigravity-acp tools/);
  await assert.rejects(fixture.handler("status extra", fixture.ctx), /Usage: \/antigravity-acp \[status\|account\|/);
  for (const command of ["usage off extra", "debug on extra", "native-tools disabled extra"]) {
    await assert.rejects(fixture.handler(command, fixture.ctx), /Usage: \/antigravity-acp/);
  }
  assert.deepEqual(fs.readdirSync(fixture.state), [], "Invalid commands must not write settings");
  assert.equal(fixture.notices.length, 0);
  assert.equal(fixture.runtimeCreates(), 0);
  fs.rmSync(fixture.state, { recursive: true, force: true });
});

test("valid permissions set the mode, persist it, and show status", async () => {
  const fixture = makeHandler();
  await fixture.handler("permissions yolo", fixture.ctx);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.state, "config.json"), "utf8")).permissions, "yolo");
  assert.match(fixture.notices[0]!, /Antigravity ACP \(OMP adapter\)/);
  // Only the status display needs the live runtime; the setter itself does not.
  assert.equal(fixture.runtimeCreates(), 1);
  fs.rmSync(fixture.state, { recursive: true, force: true });
});

test("permissions and native-tools do not mutate live state or close runtimes if persistence fails", async () => {
  const fixture = makeHandler();
  let closed = 0;
  fixture.deps.closeAllRuntimes = async () => { closed++; };
  fs.mkdirSync(fixture.deps.configPath, { recursive: true });
  fs.mkdirSync(fixture.deps.toolPolicyPath, { recursive: true });
  await assert.rejects(fixture.handler("permissions yolo", fixture.ctx));
  assert.equal(fixture.deps.getPermissionMode(), "default");
  await assert.rejects(fixture.handler("native-tools disabled", fixture.ctx));
  assert.equal(closed, 0);
  fs.rmSync(fixture.state, { recursive: true, force: true });
});
