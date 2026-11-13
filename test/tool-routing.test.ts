import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installSessionRouting,
  mcpHttpAvailable,
  normalizeInitializeResponse,
  sessionRoutingRequest,
  supportsSessionRouting,
  type InitializeMetadata,
  type SessionRpcRequest,
} from "../extension/tool-routing.ts";
import { loadNativeToolMode, saveNativeToolMode } from "../extension/tool-policy.ts";
import { AntigravityRuntime } from "../extension/runtime.mjs";
import type { AntigravityAcpConnection } from "../extension/runtime/acp/connection.ts";
import type { Model } from "@earendil-works/pi-ai";

const instructions = "# OMP session instructions\n\nCORE_POLICY\n\nDelegate separable work when requested.";
const initialize: InitializeMetadata = {
  agentInfo: { name: "antigravity-acp", version: "1.5.8" },
  agentCapabilities: {
    mcpCapabilities: { http: true },
    _meta: { antigravity: { systemPrompt: { append: true } } },
  },
};
const request: SessionRpcRequest = {
  cwd: "/fixture",
  mcpServers: [{ name: "pi-bridge", type: "http", url: "http://127.0.0.1:1" }],
};

function appendOf(routed: SessionRpcRequest): string {
  const append = routed._meta?.antigravity?.systemPrompt?.append;
  assert.ok(typeof append === "string", "the routed request must carry a string system append");
  return append;
}

test("session routing carries the complete OMP instruction and task mapping once", () => {
  const result = sessionRoutingRequest(request, initialize, "prefer", instructions);
  const append = appendOf(result);
  assert.ok(append.startsWith(instructions), "the complete native instruction must lead the append text");
  assert.match(append, /OMP tools exposed by the authenticated pi-bridge MCP server use pi_ names/);
  assert.match(append, /guidance about task maps to pi_task/);
  assert.match(append, /follow the supplied tool schema for agent selection/);
  assert.match(append, /supplied wait mechanism for completion notifications/);
  assert.match(append, /results are not OMP tool results/);
  assert.doesNotMatch(append, /Supplied OMP tools/, "the legacy routing paragraph must not be duplicated");
  assert.doesNotMatch(append, /explicit approval/, "native tools are not all gated on explicit approval");
  assert.doesNotMatch(append, /pi_read|pi_write/, "the append channel must not enumerate projected tools");
  assert.doesNotMatch(append, /no tools may be called/, "a main session may call tools");
  assert.deepEqual(result._meta?.antigravity?.eagerMcpServers, ["pi-bridge"]);
  assert.deepEqual(result._meta?.antigravity?.disabledTools, []);
  assert.equal(result._meta?.antigravity?.enabledTools, undefined);
  assert.equal(request._meta, undefined, "the caller's request must not be mutated");
});

test("an ephemeral side session keeps the full instruction but never advertises tool calls", () => {
  const append = appendOf(sessionRoutingRequest(request, initialize, "prefer", instructions, "ephemeral"));
  assert.ok(append.startsWith(instructions), "the complete native instruction still leads the append text");
  assert.match(append, /no tools may be called in this side turn/);
  assert.match(append, /tool calls are discarded without execution/);
  assert.doesNotMatch(append, /maps to pi_task/);
  assert.doesNotMatch(append, /use pi_ names|pi_read|pi_write|supplied tool schema/);
  assert.doesNotMatch(append, /supplied wait mechanism/);
});

test("capability absence cannot advertise pi_ tools in the append channel", () => {
  const noHttp: InitializeMetadata = {
    ...initialize,
    agentCapabilities: { ...initialize.agentCapabilities, mcpCapabilities: { http: false } },
  };
  const append = appendOf(sessionRoutingRequest(request, noHttp, "prefer", instructions));
  assert.match(append, /pi-bridge MCP server is not available/);
  assert.match(append, /Do not claim an OMP tool is available/);
  assert.doesNotMatch(append, /maps to pi_task/);
  assert.doesNotMatch(append, /pi_[a-z]/u);
  assert.equal(mcpHttpAvailable(noHttp), false);
  assert.equal(mcpHttpAvailable(initialize), true);
  const noBridge = sessionRoutingRequest({ cwd: "/fixture" }, initialize, "prefer", instructions);
  assert.match(appendOf(noBridge), /pi-bridge MCP server is not available/);
  assert.doesNotMatch(appendOf(noBridge), /maps to pi_task/);
});

test("official 1.5.3 omission of MCP HTTP is normalized before advertising", () => {
  const official153: InitializeMetadata = {
    agentInfo: { name: "Antigravity ACP Server", version: "1.5.3" },
    agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } },
  };
  assert.equal(normalizeInitializeResponse(official153).agentCapabilities?.mcpCapabilities?.http, true);
  assert.equal(mcpHttpAvailable(official153), true);
  const append = appendOf(sessionRoutingRequest(request, official153, "prefer", instructions));
  assert.match(append, /maps to pi_task/);
});

test("disabled mode filters built-ins but retains MCP configuration and existing metadata", () => {
  const original: SessionRpcRequest = {
    ...request,
    _meta: { other: 1, antigravity: { extra: 2, systemPrompt: { append: "Existing instructions" }, eagerMcpServers: ["other-server"] } },
  };
  const result = sessionRoutingRequest(original, initialize, "disabled", instructions);
  assert.deepEqual(result._meta?.antigravity?.enabledTools, []);
  assert.equal(result._meta?.other, 1);
  assert.equal(result._meta?.antigravity?.extra, 2);
  const append = appendOf(result);
  assert.match(append, /^Existing instructions/);
  assert.ok(append.includes(instructions));
  assert.match(append, /native tools are disabled/);
  assert.deepEqual(result._meta?.antigravity?.eagerMcpServers, ["other-server", "pi-bridge"]);
  assert.deepEqual(result.mcpServers, request.mcpServers);
  assert.equal(original._meta?.antigravity?.systemPrompt?.append, "Existing instructions");
});

test("official ACP 1.5.3 display name applies disabled routing", () => {
  const official153: InitializeMetadata = {
    agentInfo: { name: "Antigravity ACP Server", version: "1.5.3" },
    agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } },
  };
  assert.equal(supportsSessionRouting(official153), true);
  const result = sessionRoutingRequest(request, official153, "disabled", instructions);
  assert.deepEqual(result._meta?.antigravity?.enabledTools, []);
  assert.match(appendOf(result), /native tools are disabled/);
});

test("prefer mode explicitly clears an inherited strict allowlist", () => {
  const result = sessionRoutingRequest({ ...request, _meta: { antigravity: { enabledTools: [] } } }, initialize, "prefer", instructions);
  const json = JSON.parse(JSON.stringify(result)) as SessionRpcRequest;
  assert.equal(json._meta?.antigravity?.enabledTools, undefined);
  assert.deepEqual(json._meta?.antigravity?.disabledTools, []);
});

test("unknown runtimes keep the legacy prompt in prefer mode and fail closed in disabled mode", () => {
  const unknownRuntimes: InitializeMetadata[] = [
    {},
    { ...initialize, agentInfo: { name: "other", version: "1.4.1" } },
    { ...initialize, agentInfo: { name: "antigravity-acp", version: "1.3.9" } },
    { ...initialize, agentInfo: { name: "Antigravity ACP Server", version: "1.3.9" } },
    { ...initialize, agentCapabilities: {} },
    { ...initialize, agentInfo: { name: "antigravity-acp", version: "2.0.0" } },
  ];
  for (const info of unknownRuntimes) {
    assert.equal(supportsSessionRouting(info), false);
    assert.equal(sessionRoutingRequest(request, info, "prefer", instructions), request,
      "an unsupported runtime must keep the instructions-resource fallback");
    assert.throws(() => sessionRoutingRequest(request, info, "disabled", instructions), /refusing to weaken/);
  }
});

test("new, load and resume RPCs all receive the complete instruction once", async () => {
  const calls: Array<{ name: string; request: SessionRpcRequest }> = [];
  const rpc: Record<string, (request: SessionRpcRequest) => Promise<unknown>> = {};
  for (const name of ["newSession", "loadSession", "resumeSession"]) {
    rpc[name] = async (routed: SessionRpcRequest) => {
      calls.push({ name, request: routed });
      return { sessionId: "fixture" };
    };
  }
  installSessionRouting(rpc, Promise.resolve(initialize), "disabled", () => instructions);
  for (const name of ["newSession", "loadSession", "resumeSession"]) {
    assert.deepEqual(await rpc[name]!({ ...request, sessionId: "fixture" }), { sessionId: "fixture" });
  }
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.deepEqual(call.request._meta?.antigravity?.enabledTools, []);
    assert.deepEqual(call.request._meta?.antigravity?.eagerMcpServers, ["pi-bridge"]);
    const append = appendOf(call.request);
    assert.ok(append.startsWith(instructions), `${call.name} must carry the complete instruction`);
    assert.match(append, /maps to pi_task/);
    assert.match(append, /native tools are disabled/);
    assert.equal(append.match(/CORE_POLICY/gu)?.length, 1, `${call.name} must not duplicate instructions`);
  }
});

test("installSessionRouting reads the binding's ephemeral kind at session creation", async () => {
  const calls: SessionRpcRequest[] = [];
  let kind: "main" | "ephemeral" = "main";
  const applied: boolean[] = [];
  const rpc: Record<string, (request: SessionRpcRequest) => Promise<unknown>> = {};
  for (const name of ["newSession", "loadSession", "resumeSession"]) {
    rpc[name] = async (routed: SessionRpcRequest) => { calls.push(routed); return { sessionId: "fixture" }; };
  }
  installSessionRouting(rpc, Promise.resolve(initialize), "prefer", () => instructions, () => kind, advanced => applied.push(advanced));
  await rpc.newSession!(request);
  assert.match(appendOf(calls[0]!), /maps to pi_task/);
  kind = "ephemeral";
  await rpc.newSession!(request);
  const append = appendOf(calls[1]!);
  assert.match(append, /no tools may be called in this side turn/);
  assert.doesNotMatch(append, /maps to pi_task/);
  assert.deepEqual(applied, [true, true]);
});

test("strict compatibility failure never dispatches a session RPC", async () => {
  let count = 0;
  const rpc: Record<string, (request: SessionRpcRequest) => Promise<unknown>> = {};
  for (const name of ["newSession", "loadSession", "resumeSession"]) {
    rpc[name] = async () => { count++; };
  }
  installSessionRouting(rpc, Promise.resolve({}), "disabled", () => instructions);
  await assert.rejects(rpc.newSession!(request), /refusing to weaken/);
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

interface PromptRequest {
  sessionId: string;
  prompt: Array<{ type: string; resource?: { uri: string; mimeType: string; text: string } }>;
}

test("a runtime without system append keeps full instructions plus legacy pi_task guidance", async () => {
  const prompts: PromptRequest[] = [];
  const modes = { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] };
  const models = { currentModelId: "fixture-model", availableModels: [{ modelId: "fixture-model", name: "Fixture" }] };
  const exited = Promise.withResolvers<{ code: number }>();
  let alive = true;
  const connection = {
    process: { alive: true, exited: exited.promise },
    async initialize() {
      return { protocolVersion: 1, agentCapabilities: {
        promptCapabilities: { embeddedContext: true }, mcpCapabilities: { http: true },
      } };
    },
    async newSession() { return { sessionId: "legacy-session", modes, models }; },
    getSessionState() { return { modes, models }; },
    holdPromptWatchdog() { return () => {}; },
    async prompt(request: PromptRequest) { prompts.push(request); return { stopReason: "end_turn" }; },
    async close() {
      if (!alive) return;
      alive = false;
      connection.process.alive = false;
      exited.resolve({ code: 0 });
    },
  };
  const runtime = new AntigravityRuntime(() => connection as unknown as AntigravityAcpConnection, "yolo");
  const model: Model<"antigravity-acp"> = {
    id: "fixture-model", name: "Fixture", api: "antigravity-acp", provider: "antigravity-acp",
    contextWindow: 524_288, maxTokens: 32_000, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  try {
    for await (const _event of runtime.stream(model, {
      systemPrompt: "CORE_POLICY",
      tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } }],
      messages: [{ role: "user", content: "LEGACY_REQUEST", timestamp: 1 }],
    }, { sessionId: "legacy-session" }).stream) { /* drain */ }
    assert.equal(prompts.length, 1);
    const resource = prompts[0]!.prompt.find(block => block.type === "resource");
    assert.ok(resource && resource.resource, "a legacy runtime must keep the instructions resource");
    assert.equal(resource.resource.uri, "urn:omp:antigravity-acp:instructions");
    assert.match(resource.resource.text, /CORE_POLICY/);
    assert.match(resource.resource.text, /maps to pi_task/);
    assert.match(resource.resource.text, /pi-bridge MCP server/);
    assert.doesNotMatch(resource.resource.text, /Supplied OMP tools/);
  } finally {
    await runtime.close();
  }
});
