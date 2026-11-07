import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installSessionRouting, sessionRoutingRequest, supportsSessionRouting } from "../extension/tool-routing.ts";
import { loadNativeToolMode, saveNativeToolMode } from "../extension/tool-policy.ts";

const initialize = { agentInfo: { name: "antigravity-acp", version: "1.4.1" },
  agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } } };
const request = { cwd: "/fixture", mcpServers: [{ name: "pi-bridge", type: "http", url: "http://127.0.0.1:1" }] };

test("routing uses advertised system extension and eagerly loads only the bridge", () => {
  const result = sessionRoutingRequest(request, initialize, "prefer");
  const meta = result._meta.antigravity;
  assert.match(meta.systemPrompt.append, /Supplied OMP tools/);
  assert.match(meta.systemPrompt.append, /explicit approval/);
  assert.deepEqual(meta.eagerMcpServers, ["pi-bridge"]);
  assert.deepEqual(meta.disabledTools, []);
  assert.equal(meta.enabledTools, undefined);
  assert.equal((request as any)._meta, undefined);
});

test("strict mode filters built-ins but retains MCP configuration and existing metadata", () => {
  const original = { ...request, _meta: { other: 1, antigravity: { extra: 2, systemPrompt: { append: "Existing instructions" }, eagerMcpServers: ["other-server"] } } };
  const result = sessionRoutingRequest(original, initialize, "disabled");
  assert.deepEqual(result._meta.antigravity.enabledTools, []);
  assert.equal(result._meta.other, 1);
  assert.equal(result._meta.antigravity.extra, 2);
  assert.match(result._meta.antigravity.systemPrompt.append, /^Existing instructions/);
  assert.deepEqual(result._meta.antigravity.eagerMcpServers, ["other-server", "pi-bridge"]);
  assert.deepEqual(result.mcpServers, request.mcpServers);
  assert.equal(original._meta.antigravity.systemPrompt.append, "Existing instructions");
});

test("prefer mode explicitly clears an inherited strict allowlist", () => {
  const result = sessionRoutingRequest({ ...request, _meta: { antigravity: { enabledTools: [] } } }, initialize, "prefer");
  const json = JSON.parse(JSON.stringify(result));
  assert.equal(json._meta.antigravity.enabledTools, undefined);
  assert.deepEqual(json._meta.antigravity.disabledTools, []);
});

test("unknown runtimes fall back in prefer mode and fail closed in disabled mode", () => {
  for (const info of [ {}, { ...initialize, agentInfo: { name: "other", version: "1.4.1" } },
    { ...initialize, agentInfo: { name: "antigravity-acp", version: "1.3.9" } },
    { ...initialize, agentCapabilities: {} },
    { ...initialize, agentInfo: { name: "antigravity-acp", version: "2.0.0" } } ]) {
    assert.equal(supportsSessionRouting(info), false);
    assert.equal(sessionRoutingRequest(request, info, "prefer"), request);
    assert.throws(() => sessionRoutingRequest(request, info, "disabled"), /refusing to weaken/);
  }
});

test("all session creation and restoration RPCs receive the same policy", async () => {
  const calls: any[] = [];
  const rpc = Object.fromEntries(["newSession", "loadSession", "resumeSession"].map(name => [name, async (r: any) => { calls.push({ name, request: r }); return { sessionId: "fixture" }; }]));
  installSessionRouting(rpc, Promise.resolve(initialize), "disabled");
  for (const name of ["newSession", "loadSession", "resumeSession"]) {
    assert.equal((await rpc[name]({ ...request, sessionId: "fixture" })).sessionId, "fixture");
  }
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.deepEqual(call.request._meta.antigravity.enabledTools, []);
    assert.deepEqual(call.request._meta.antigravity.eagerMcpServers, ["pi-bridge"]);
    assert.match(call.request._meta.antigravity.systemPrompt.append, /Supplied OMP tools/);
  }
});

test("strict compatibility failure never dispatches a session RPC", async () => {
  let count = 0;
  const rpc = Object.fromEntries(["newSession", "loadSession", "resumeSession"].map(name => [name, async () => { count++; }]));
  installSessionRouting(rpc, Promise.resolve({}), "disabled");
  await assert.rejects(rpc.newSession(request), /refusing to weaken/);
  assert.equal(count, 0);
});

test("tool policy persists independently and rejects invalid data instead of weakening it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-tool-policy-"));
  const file = path.join(root, "omp-tools.json");
  try {
    assert.equal(loadNativeToolMode(file), "prefer");
    saveNativeToolMode(file, "disabled");
    assert.equal(loadNativeToolMode(file), "disabled");
    assert.deepEqual(fs.readdirSync(root), ["omp-tools.json"]);
    saveNativeToolMode(file, "prefer");
    assert.equal(loadNativeToolMode(file), "prefer");
    fs.writeFileSync(file, '{"nativeTools":"typo"}');
    assert.throws(() => loadNativeToolMode(file), /Invalid OMP ACP tool policy/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
