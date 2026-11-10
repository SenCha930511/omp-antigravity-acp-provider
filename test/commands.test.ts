import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAntigravityArgumentCompletions, createAntigravityCommandHandler, type CommandControllerDeps, type RuntimeBundleView } from "../extension/commands.ts";
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
  assert.match(fixture.notices[0]!, /"configured": "off"/);
  assert.match(fixture.notices[0]!, /"effective": "off"/);
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

test("valid permissions persist and expose the requested state before closing every runtime exactly once", async () => {
  const fixture = makeHandler();
  let requested = "default", closed = 0;
  const mutations: string[] = [], legacyCalls: string[] = [];
  const runtimes = [bundle, bundle].map(existing => ({
    ...existing,
    runtime: { ...existing.runtime, setPermissionMode: async (mode: string) => { legacyCalls.push(mode); } },
  }));
  fixture.deps.getPermissionMode = () => requested;
  fixture.deps.setPermissionModeState = mode => { requested = mode; mutations.push(mode); };
  fixture.deps.getAllRuntimes = () => runtimes;
  fixture.deps.closeAllRuntimes = async () => {
    closed++;
    assert.equal(requested, "yolo", "new state must be visible before pool teardown begins");
    assert.deepEqual(mutations, ["yolo"]);
    assert.equal(JSON.parse(fs.readFileSync(fixture.deps.configPath, "utf8")).permissions, "yolo", "persistence precedes teardown");
  };
  await fixture.handler("permissions yolo", fixture.ctx);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.state, "config.json"), "utf8")).permissions, "yolo");
  assert.equal(requested, "yolo");
  assert.deepEqual(mutations, ["yolo"]);
  assert.equal(closed, 1, "closeAllRuntimes owns teardown of the entire pool");
  assert.deepEqual(legacyCalls, [], "a dangerous process must never receive a legacy in-place mode change");
  assert.match(fixture.notices[0]!, /Antigravity ACP \(OMP adapter\)/);
  // Only the status display needs the live runtime; the setter itself does not.
  assert.equal(fixture.runtimeCreates(), 1);
  fs.rmSync(fixture.state, { recursive: true, force: true });
});

test("reselecting the current permission mode does not close runtimes or rewrite settings", async () => {
  const fixture = makeHandler();
  let closed = 0, mutations = 0;
  fixture.deps.getPermissionMode = () => "default";
  fixture.deps.setPermissionModeState = () => { mutations++; };
  fixture.deps.closeAllRuntimes = async () => { closed++; };
  await fixture.handler("permissions default", fixture.ctx);
  assert.equal(closed, 0);
  assert.equal(mutations, 0);
  assert.equal(fs.existsSync(fixture.deps.configPath), false);
  fs.rmSync(fixture.state, { recursive: true, force: true });
});

test("permissions and native-tools do not mutate live state or close runtimes if persistence fails", async () => {
  const fixture = makeHandler();
  let requested = "default", closed = 0;
  const permissionMutations: string[] = [], policyMutations: string[] = [], legacyCalls: string[] = [];
  fixture.deps.getPermissionMode = () => requested;
  fixture.deps.setPermissionModeState = mode => { requested = mode; permissionMutations.push(mode); };
  fixture.deps.setToolPolicy = policy => { policyMutations.push(policy.nativeTools); };
  fixture.deps.getAllRuntimes = () => [{
    ...bundle,
    runtime: { ...bundle.runtime, setPermissionMode: async (mode: string) => { legacyCalls.push(mode); } },
  }];
  fixture.deps.closeAllRuntimes = async () => { closed++; };
  fs.mkdirSync(fixture.deps.configPath, { recursive: true });
  fs.mkdirSync(fixture.deps.toolPolicyPath, { recursive: true });
  await assert.rejects(fixture.handler("permissions yolo", fixture.ctx));
  assert.equal(requested, "default");
  await assert.rejects(fixture.handler("native-tools disabled", fixture.ctx));
  assert.equal(closed, 0);
  assert.deepEqual(permissionMutations, []);
  assert.deepEqual(policyMutations, []);
  assert.deepEqual(legacyCalls, []);
  fs.rmSync(fixture.state, { recursive: true, force: true });
});

test("status and tools hold a runtime lease for their snapshot", async () => {
  const fixture = makeHandler();
  let acquired = 0, released = 0;
  fixture.deps.acquireRuntimeForSession = () => {
    acquired++;
    return { value: bundle, release: () => { released++; } };
  };
  await fixture.handler("status", fixture.ctx);
  await fixture.handler("tools", fixture.ctx);
  assert.equal(acquired, 2);
  assert.equal(released, 2);
  fs.rmSync(fixture.state, { recursive: true, force: true });
});

function makeCompletions(modelIds = ["gemini-3.8-flash", "gemini-4-argon"]) {
  const complete = createAntigravityArgumentCompletions({ catalog: { currentModels: modelIds.map(id => ({ id })) } });
  const items = (args: string) => {
    const result = complete(args);
    assert.ok(result, `expected completions for ${JSON.stringify(args)}`);
    return result;
  };
  return { complete, items };
}

test("argument completions list every subcommand and stay in sync with the handler usage error", async () => {
  const { items } = makeCompletions();
  const all = items("");
  const labels = all.map(item => item.label);
  assert.deepEqual(labels,
    ["status", "account", "login", "logout", "tools", "usage", "context", "cleanup", "diagnostics", "debug", "native-tools", "permissions", "refresh"]);
  for (const item of all) {
    assert.equal(item.value, `${item.label} `);
    assert.ok(item.description.length > 0);
  }
  const fixture = makeHandler();
  await assert.rejects(fixture.handler("__nosuch", fixture.ctx), (error: Error) => {
    const listed = error.message.slice(error.message.indexOf("[") + 1, error.message.indexOf("]")).split("|");
    assert.deepEqual(listed, labels);
    return true;
  });
  fs.rmSync(fixture.state, { recursive: true, force: true });
});

test("argument completions filter by prefix, ignore case, and chain fixed values", () => {
  const { complete, items } = makeCompletions();
  assert.deepEqual(items("cl").map(item => item.label), ["cleanup"]);
  assert.match(items("cl")[0]!.hint ?? "", /^eanup /);
  const [status] = items("status");
  assert.ok(status);
  assert.equal(status.hint, undefined);
  assert.equal(complete("zzz"), null);
  assert.deepEqual(items("CLEANUP b").map(item => item.label), ["balanced", "budget"]);
  assert.equal(items("CLEANUP b")[0]!.value, "cleanup balanced ");
  assert.deepEqual(items("usage a").map(item => item.label), ["auto"]);
  assert.equal(items("usage a")[0]!.value, "usage auto ");
  assert.deepEqual(items("diagnostics res").map(item => item.label), ["reset"]);
  assert.deepEqual(items("debug o").map(item => item.label), ["on", "off"]);
  assert.deepEqual(items("native-tools p").map(item => item.label), ["prefer"]);
  assert.deepEqual(items("permissions auto-e").map(item => item.label), ["auto-edit"]);
  assert.deepEqual(items("permissions y").map(item => item.label), ["yolo"]);
  assert.equal(complete("usage x"), null);
  assert.equal(complete("status x"), null);
  assert.equal(complete("refresh "), null);
  assert.equal(complete("login x"), null);
  assert.equal(complete(" "), null);
});

test("context set completions walk the target and setting-key positions", () => {
  const { complete, items } = makeCompletions();
  assert.deepEqual(items("context s").map(item => item.label), ["set"]);
  assert.equal(items("context s")[0]!.value, "context set ");
  assert.deepEqual(items("context set ").map(item => item.label), ["default", "gemini-3.8-flash", "gemini-4-argon"]);
  assert.equal(items("context set gem").length, 2);
  const [firstKey] = items("context set default ");
  assert.ok(firstKey);
  assert.equal(firstKey.value, "context set default contextWindow ");
  assert.ok(items("context set default ").map(item => item.label).includes("usageMode"));
  const modelKeys = items("context set gemini-4-argon ").map(item => item.label);
  assert.ok(!modelKeys.includes("usageMode"));
  assert.ok(modelKeys.includes("maxTokens"));
  assert.deepEqual(items("context set default maxT").map(item => item.label), ["maxTokens", "maxTransferBytes"]);
  assert.equal(complete("context set default usageMode "), null);
  assert.equal(complete("context settypo default "), null);
});
