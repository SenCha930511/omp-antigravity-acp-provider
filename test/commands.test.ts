import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAntigravityArgumentCompletions, createAntigravityCommandHandler, type CommandControllerDeps, type RuntimeBundleView } from "../extension/commands.ts";
import type { OmpCommandContext } from "../extension/auth-sync.ts";
import { SessionCleanup } from "../extension/session-cleanup.ts";
import { Diagnostics } from "../extension/diagnostics.ts";
import type { TierConnection } from "../extension/tier-connection.ts";

const bundle: RuntimeBundleView = {
  runtime: {
    snapshot: async () => ({ bindings: 0, permissionMode: "yolo", metrics: {}, processes: [] }),
    quota: async () => { throw new Error("quota fixture not configured"); },
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

test("cleanup configuration starts the collector exactly once", async () => {
  const fixture = makeHandler();
  let starts = 0;
  let configured: string | undefined;
  fixture.deps.cleanup = {
    status: () => ({ mode: "conservative", idleDays: 7, file: "", scope: "adapter-owned local ACP data", warning: "Soft budget exceeded", failures: 1 }),
    configure: (mode: string) => { configured = mode; },
    start: () => { starts++; },
    stop: () => {},
    collect: async () => 2,
  } as CommandControllerDeps["cleanup"];
  await fixture.handler("cleanup conservative", fixture.ctx);
  assert.equal(configured, "conservative");
  assert.equal(starts, 1);
  assert.match(fixture.notices[0]!, /Removed this run:\s+2/);
  assert.match(fixture.notices[0]!, /Warning:\s+Soft budget exceeded/);
  assert.match(fixture.notices[0]!, /Failures:\s+1/);
  assert.doesNotMatch(fixture.notices[0]!, /"removed"|"warning"/);
  fs.rmSync(fixture.state, { recursive: true, force: true });
});

test("balanced cleanup command persists retention and accepts custom days without starting a model", async t => {
  const f = makeHandler(), acp = path.join(fs.realpathSync(f.state), "acp");
  fs.mkdirSync(acp);
  const cleanup = new SessionCleanup(fs.realpathSync(f.state), acp);
  f.deps.cleanup = cleanup;
  t.after(async () => { await cleanup.stop(); fs.rmSync(f.state, { recursive: true, force: true }); });
  await f.handler("cleanup balanced", f.ctx);
  assert.match(f.notices.at(-1)!, /Mode:\s+balanced/);
  assert.match(f.notices.at(-1)!, /Idle retention:\s+7 days/);
  assert.match(f.notices.at(-1)!, /Recovery:\s+1 day/);
  assert.match(f.notices.at(-1)!, /Byte budget:\s+512 MiB/);
  assert.match(f.notices.at(-1)!, /Removed this run:\s+0/);
  assert.match(f.notices.at(-1)!, /Risk:\s+Active sessions are protected.*OMP history is retained/);
  assert.doesNotMatch(f.notices.at(-1)!, /"maxBytes"|"note"/);
  let policy = JSON.parse(fs.readFileSync(cleanup.policyPath, "utf8"));
  assert.equal(policy.mode, "balanced"); assert.equal(policy.idleDays, 7); assert.equal(policy.recoveryDays, 1);
  assert.equal(policy.maxBytes, 512 * 1024 * 1024);
  await f.handler("cleanup balanced 14", f.ctx);
  policy = JSON.parse(fs.readFileSync(cleanup.policyPath, "utf8")); assert.equal(policy.idleDays, 14);
  assert.match(f.notices.at(-1)!, /Idle retention:\s+14 days/);
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
  assert.match(fixture.notices[0]!, /Queries:\s+off → off/);
  assert.doesNotMatch(fixture.notices[0]!, /Connection|configured|effective|\{/);
  await fixture.handler("account", fixture.ctx);
  const account = fixture.notices[1]!;
  assert.match(account, /Antigravity ACP account/);
  assert.match(account, /Saved ACP sessions:\s+0/);
  assert.match(account, /Permission:\s+default/);
  assert.match(account, /Active sessions:\s+0/);
  assert.match(account, /Token ownership:.*Antigravity-owned storage/);
  await fixture.handler("refresh", fixture.ctx);
  assert.match(fixture.notices[2]!, /ACP model cache refreshed/);
  assert.match(fixture.notices[2]!, /Models:\s+none advertised/);
  assert.equal(fixture.runtimeCreates(), 0);
  fs.rmSync(fixture.state, { recursive: true, force: true });
});

test("account retains credential-store errors without starting a runtime", async () => {
  const fixture = makeHandler();
  fixture.ctx.modelRegistry = {
    authStorage: { credentials: { getOAuth: () => { throw new Error("credential store unavailable"); } } },
  };
  await fixture.handler("account", fixture.ctx);
  assert.match(fixture.notices[0]!, /OMP login marker:\s+unknown; host did not expose the credential store/);
  assert.match(fixture.notices[0]!, /OMP warning:\s+credential store unavailable/);
  assert.doesNotMatch(fixture.notices[0]!, /\{|"present"/);
  assert.equal(fixture.runtimeCreates(), 0);
  fs.rmSync(fixture.state, { recursive: true, force: true });
});

test("quota reports formatted live groups without ephemeral usage noise while holding and releasing a runtime lease", async () => {
  const fixture = makeHandler();
  let prepared = 0, released = 0, quotaCalls = 0;
  fixture.deps.prepareRuntime = async () => { prepared++; };
  fixture.deps.acquireRuntimeForSession = () => ({
    value: {
      ...bundle,
      runtime: {
        ...bundle.runtime,
        quota: async () => {
          quotaCalls++;
          return { at: Date.UTC(2026, 10, 10, 12), groups: [
            { displayName: "Gemini 4 Argon", buckets: [
              { window: "5h", remainingFraction: 0.42, resetTime: "2026-11-10T18:30:00.000Z" },
              { window: "weekly", remainingFraction: 0.75 },
            ] },
            { displayName: "Gemini 3.8 Flash", buckets: [] },
          ] };
        },
        snapshot: async () => ({ bindings: 1, permissionMode: "yolo", metrics: { totals: { turns: 3 } }, processes: [] }),
      },
    },
    release: () => { released++; },
  });
  await fixture.handler("quota", fixture.ctx);
  assert.equal(prepared, 1);
  assert.equal(quotaCalls, 1);
  assert.equal(released, 1);
  const report = fixture.notices[0]!;
  assert.match(report, /^Antigravity quota\n  Gemini 4 Argon\n    5h\s+42% remaining · reset 2026-11-10T18:30:00.000Z\n    weekly\s+75% remaining/);
  assert.match(report, /  Gemini 3.8 Flash\n    no percentage limits reported/);
  assert.doesNotMatch(report, /Usage:|\{|\},|displayName|remainingFraction/);
  assert.equal(fixture.runtimeCreates(), 0);
  fs.rmSync(fixture.state, { recursive: true, force: true });
});

test("quota failures are explicit reports and extra arguments do not prepare a runtime", async () => {
  const fixture = makeHandler();
  await fixture.handler("quota", fixture.ctx);
  assert.match(fixture.notices[0]!, /Antigravity quota\n  Status:\s+unavailable\n  Reason:\s+quota fixture not configured/);
  await assert.rejects(fixture.handler("quota extra", fixture.ctx), /^Error: Usage: \/antigravity-acp quota$/);
  assert.equal(fixture.runtimeCreates(), 1, "only the valid quota query creates a runtime");
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
  const lines = fixture.notices[0]!.split("\n");
  assert.equal(lines[0], "Antigravity ACP (OMP adapter)");
  assert.ok(lines.slice(1).every(line => line.startsWith("  ")), "status fields form one indented list");
  assert.match(fixture.notices[0]!, /Permission:\s+requested default → wire yolo/);
  assert.match(fixture.notices[0]!, /Active sessions:\s+0/);
  assert.doesNotMatch(fixture.notices[0]!, /Processes|omittedTools|\{|\}/);
  assert.equal(fixture.notices[1], "No model request yet. Send a message with this ACP model to inspect its offered OMP tools.");
  assert.equal(acquired, 2);
  assert.equal(released, 2);
  fs.rmSync(fixture.state, { recursive: true, force: true });
});

test("status summarizes live runtime details without process JSON or zero metric noise", async () => {
  const fixture = makeHandler();
  let acquired = 0, released = 0;
  fixture.deps.acquireRuntimeForSession = () => {
    acquired++;
    return {
      value: {
        ...bundle,
        runtime: {
          ...bundle.runtime,
          snapshot: async () => ({
            bindings: 1,
            permissionMode: "accept-edits",
            metrics: {
              totals: { turns: 3, input: 1_200, output: 40, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
              latestQuota: { remaining: 0, limit: 100, resetAt: "2026-11-10T18:30:00.000Z" },
            },
            processes: [{ mcpHttp: true, omittedTools: [], agentVersion: "1.5.3", alive: false, ignoredStdoutNoiseLines: 2 }],
          }),
        },
      },
      release: () => { released++; },
    };
  };
  fixture.deps.connections.add({
    toolRouting: { nativeTools: "prefer", channel: "system-append" },
    confirmedThinking: { model: "gemini-test", effort: "high" },
  } as unknown as TierConnection);
  await fixture.handler("status", fixture.ctx);
  const report = fixture.notices[0]!;
  assert.match(report, /Runtime:\s+1\.5\.3/);
  assert.match(report, /Native channel:\s+system-append/);
  assert.match(report, /Permission:\s+requested default → wire accept-edits/);
  assert.match(report, /Thinking:\s+gemini-test=high/);
  assert.match(report, /Usage record:\s+3 turns · 1,200 input · 40 output/);
  assert.doesNotMatch(report, /reasoning|cacheRead|cacheWrite/);
  assert.match(report, /Latest quota:\s+0 \/ 100 remaining · reset 2026-11-10T18:30:00.000Z/);
  assert.match(report, /Runtime warning:\s+1 stopped process/);
  assert.match(report, /API warning:\s+2 ignored stdout noise lines/);
  assert.doesNotMatch(report, /processes|mcpHttp|waitingForTools|\{|\}/);
  assert.equal(acquired, 1);
  assert.equal(released, 1);
  fs.rmSync(fixture.state, { recursive: true, force: true });
});

test("tools lists every projected and live tool omission with its reason", async () => {
  const fixture = makeHandler();
  let released = 0;
  fixture.deps.getLastToolAudit = () => ({
    offered: ["read", "unsupported"],
    available: ["read"],
    omitted: [{ name: "unsupported", reason: "Schema contains unsupported union" }],
  });
  fixture.deps.acquireRuntimeForSession = () => ({
    value: {
      ...bundle,
      runtime: {
        ...bundle.runtime,
        snapshot: async () => ({
          bindings: 1,
          permissionMode: "default",
          metrics: {},
          processes: [{ key: "runtime-key", mcpHttp: false, omittedTools: [{ name: "live-only", reason: "Agent did not advertise MCP over HTTP" }] }],
        }),
      },
    },
    release: () => { released++; },
  });
  await fixture.handler("tools", fixture.ctx);
  const report = fixture.notices[0]!;
  assert.match(report, /Offered:\s+2/);
  assert.match(report, /Available:\s+read/);
  assert.match(report, /unsupported:\s+Schema contains unsupported union/);
  assert.match(report, /MCP over HTTP:\s+no/);
  assert.match(report, /Omitted live-only:\s+Agent did not advertise MCP over HTTP/);
  assert.doesNotMatch(report, /"omitted"|omittedTools|\[|\{/);
  assert.equal(released, 1);
  fs.rmSync(fixture.state, { recursive: true, force: true });
});

test("diagnostics prints count, median and max per stage without empty statistics", async () => {
  const fixture = makeHandler();
  const diagnostics = new Diagnostics(path.join(fixture.state, "diagnostics.json"));
  fixture.deps.diagnostics = diagnostics;
  await fixture.handler("diagnostics", fixture.ctx);
  assert.match(fixture.notices[0]!, /Collection:\s+off/);
  assert.doesNotMatch(fixture.notices[0]!, /Samples|stages|\{|\}/);
  diagnostics.configure(true);
  diagnostics.record("history.compare", 1.25);
  diagnostics.record("history.compare", 3.5);
  await fixture.handler("diagnostics", fixture.ctx);
  const report = fixture.notices[1]!;
  assert.match(report, /Collection:\s+on/);
  assert.match(report, /Samples:\s+2 \/ 128/);
  assert.match(report, /history\.compare:\s+count 2 · median 3\.5 ms · max 3\.5 ms/);
  assert.doesNotMatch(report, /"medianMs"|"samples"/);
  fs.rmSync(fixture.state, { recursive: true, force: true });
});

test("context separates shared settings, effective limits and model-only overrides", async () => {
  const fixture = makeHandler();
  fixture.deps.getContextSettings = () => ({
    defaults: { reserveTokens: 5_000, maxTransferBytes: 65_536, usageMode: "auto" },
    models: { "gemini-test": { maxTokens: 8_000, maxImageBytes: 0 } },
  });
  fixture.deps.catalog.currentModels = [{ id: "gemini-test", contextWindow: 100_000, maxTokens: 10_000 } as CommandControllerDeps["catalog"]["currentModels"][number]];
  await fixture.handler("context", fixture.ctx);
  const report = fixture.notices[0]!;
  assert.match(report, /Shared defaults\n[\s\S]*reserveTokens:\s+5,000 tokens/);
  assert.match(report, /usageMode:\s+auto/);
  assert.match(report, /Context window:\s+100,000 tokens/);
  assert.match(report, /Output limit:\s+8,000 tokens/);
  assert.match(report, /Input budget:\s+87,000 tokens/);
  assert.match(report, /Transfer limit:\s+64 KiB/);
  assert.match(report, /Image limit:\s+0 B/);
  assert.match(report, /Overrides:\s+maxTokens=8,000 tokens, maxImageBytes=0 B/);
  assert.doesNotMatch(report, /context\.json|"settings"|"effective"/);
  assert.equal(fixture.runtimeCreates(), 0);
  fs.rmSync(fixture.state, { recursive: true, force: true });
});

test("usage keeps context compatibility details and compaction/accounting errors while omitting idle connections", async () => {
  const fixture = makeHandler();
  fixture.deps.getContextSettings = () => ({ defaults: { usageMode: "auto" }, models: {} });
  const connection = {
    contextUsage: new Map([["session-a", { used: 500, size: 1_000 }]]),
    getOmpContextWindow: () => 2_000,
    compactions: new Map([["session-a", new Map([["compact-1", {
      sessionId: "session-a", compactionId: "compact-1", status: "failed", summary: "", error: "ACP compaction failed: backend detail", updatedAt: 1, notified: true,
    }]])]]),
    usageStatus: new Map([["session-a", { source: "unavailable", cache: "unknown", error: "Official usage query failed or timed out" }]]),
    activePrompts: 0,
  } as unknown as TierConnection;
  fixture.deps.connections.add(connection);
  fixture.deps.connections.add({ contextUsage: new Map(), compactions: new Map(), usageStatus: new Map(), activePrompts: 0 } as unknown as TierConnection);
  const before = process.env.OMP_ACP_USAGE;
  process.env.OMP_ACP_USAGE = "off";
  try {
    await fixture.handler("usage", fixture.ctx);
  } finally {
    if (before === undefined) delete process.env.OMP_ACP_USAGE;
    else process.env.OMP_ACP_USAGE = before;
  }
  const report = fixture.notices[0]!;
  assert.match(report, /Queries:\s+auto → off · OMP_ACP_USAGE=off override/);
  assert.match(report, /Context session-a:\s+500 \/ 1,000 ACP tokens · OMP window 2,000/);
  assert.match(report, /Compaction session-a\/compact-1:\s+failed/);
  assert.match(report, /Compaction error compact-1:\s+ACP compaction failed: backend detail/);
  assert.match(report, /Accounting session-a:\s+unavailable · cache unknown/);
  assert.match(report, /Accounting error session-a:\s+Official usage query failed or timed out/);
  assert.equal((report.match(/Connection \d/g) ?? []).length, 1);
  assert.doesNotMatch(report, /Active prompts|"connections"|"compactions"/);
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
    ["status", "account", "login", "logout", "tools", "usage", "quota", "context", "cleanup", "diagnostics", "debug", "native-tools", "permissions", "refresh"]);
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
