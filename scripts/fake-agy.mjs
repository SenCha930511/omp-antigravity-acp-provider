// Minimal ACP v1 agent over stdio for wire-level adapter tests. It never calls
// a model: prompt text selects a deterministic scripted response. Tool calls
import { appendFileSync } from "node:fs";
// go through the real loopback MCP bridge with its bearer token.
import { createInterface } from "node:readline";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  TOOL_RELAY_CONTROL_NAME,
  parseRelayCallId,
} from "../extension/tool-relay-protocol.mjs";

const sessions = new Map();
let nextSession = 1;
let nextServerRequest = 1;
const log = value => {
  const file = process.env.FAKE_AGY_LOG;
  if (!file) return;
  appendFileSync(file, `${JSON.stringify(value)}\n`);
};

const send = message => {
  if (!process.stdout.writable) return;
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const respondError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const notify = (state, update) => send({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId: state.id, update },
});
const message = text => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const thought = text => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
const toolCall = (toolCallId, title, status, extra = {}) => ({
  sessionUpdate: "tool_call",
  toolCallId,
  title,
  status,
  ...extra,
});
const toolCallUpdate = (toolCallId, patch) => ({
  sessionUpdate: "tool_call_update",
  toolCallId,
  ...patch,
});

const modern = process.env.FAKE_AGY_PROFILE === "cli-1.5.3";
const agentName = process.env.FAKE_AGY_AGENT_NAME ?? "Antigravity ACP Server";
const mcpHttpOverride = process.env.FAKE_AGY_MCP_HTTP;
const modes = { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] };
const models = { currentModelId: "gemini-3.8-flash", availableModels: [{ modelId: "gemini-3.8-flash", name: "Flash" }] };
const modernModes = [
  { value: "default", name: "Default" },
  { value: "accept-edits", name: "Accept edits" },
  { value: "plan", name: "Plan" },
];
const modernModels = [{ value: "gemini-3.8-flash", name: "Flash" }];

function configOptions(state) {
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: state.model, options: modernModels },
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: state.mode, options: modernModes },
  ];
}

function logMode(state, method) {
  log({ event: "mode", session: state.id, method, mode: state.mode });
}

log({
  event: "start",
  profile: modern ? "cli-1.5.3" : "legacy",
  argv: process.argv.slice(2),
  autoApproveMarker: process.env.OMP_ACP_DANGEROUSLY_SKIP_PERMISSIONS ?? "",
});

function debug(text) {
  if (process.env.FAKE_AGY_DEBUG) process.stderr.write(`[fake-agy] ${text}\n`);
}

async function connectMcp(descriptor) {
  if (descriptor?.type !== "http" || typeof descriptor.url !== "string") return undefined;
  const headers = Object.fromEntries((descriptor.headers ?? []).map(header => [header.name, header.value]));
  const transport = new StreamableHTTPClientTransport(new URL(descriptor.url), {
    requestInit: { headers },
  });
  const client = new Client(
    { name: "fake-agy", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { client, transport, tools };
}

async function createSession(params) {
  const id = `fake-${nextSession++}`;
  const state = {
    id,
    pending: new Map(),
    prompt: undefined,
    servers: new Map(),
    tools: new Map(),
    cancelWaiters: [],
    cancelled: false,
    mode: modern ? "default" : "yolo",
    model: "gemini-3.8-flash",
  };
  sessions.set(id, state);
  logMode(state, "session/new");
  for (const descriptor of params.mcpServers ?? []) {
    const connection = await connectMcp(descriptor);
    if (!connection) continue;
    state.servers.set(descriptor.name, connection);
    for (const tool of connection.tools) state.tools.set(tool.name, connection);
    log({ event: "server", session: id, name: descriptor.name, tools: connection.tools.map(tool => tool.name) });
    debug(`session ${id} connected ${descriptor.name} (${connection.tools.length} tools)`);
  }
  return state;
}

function sessionResponse(state) {
  return modern
    ? { sessionId: state.id, configOptions: configOptions(state) }
    : { sessionId: state.id, modes, models };
}

function ask(state, method, params) {
  const id = `${state.id}-server-${nextServerRequest++}`;
  return new Promise(resolve => {
    state.pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function finishPrompt(state, id, result) {
  if (state.prompt?.id !== id) return;
  state.prompt = undefined;
  log({ event: "finish", id, result });
  respond(id, result);
}

function cancelState(state) {
  state.cancelled = true;
  for (const waiter of state.cancelWaiters.splice(0)) waiter();
  for (const [id, resolve] of state.pending) {
    state.pending.delete(id);
    resolve({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
  }
  if (state.prompt) {
    const { id } = state.prompt;
    state.prompt = undefined;
    respond(id, { stopReason: "cancelled" });
  }
}

function textOf(result) {
  return (result?.content ?? [])
    .filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text)
    .join("\n");
}

async function callTool(state, name, args) {
  const connection = state.tools.get(name);
  if (!connection) throw new Error(`fake-agy has no MCP tool named ${name}`);
  log({ event: "call", name, args });
  const result = await connection.client.callTool({ name, arguments: args });
  log({ event: "result", name, text: textOf(result), isError: result?.isError === true });
  return result;
}

function relayCallId(result) {
  if (!result || result.isError === true) return undefined;
  return parseRelayCallId(textOf(result));
}

async function callToolWithRelay(state, name, args) {
  let result = await callTool(state, name, args);
  const callId = relayCallId(result);
  log({ event: "relay", name, callId, text: textOf(result) });
  if (!callId) return result;
  for (let attempt = 0; attempt < 1000; attempt++) {
    result = await callTool(state, TOOL_RELAY_CONTROL_NAME, { call_id: callId });
    if (!relayCallId(result)) return result;
  }
  return result;
}

async function permissionScript(state) {
  const result = await ask(state, "session/request_permission", {
    sessionId: state.id,
    toolCall: {
      toolCallId: "call-1",
      title: "Forged title: read /secret",
      kind: "read",
      status: "pending",
      rawInput: { path: "/secret", tool: "read" },
      locations: [],
      content: [],
    },
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ],
  });
  const outcome = result?.result?.outcome;
  notify(state, message(`PERMISSION:${outcome?.outcome ?? "missing"}:${outcome?.optionId ?? ""}`));
}

async function identityPermissionScript(state) {
  const toolCallId = "identity-call-1";
  notify(state, toolCall(toolCallId, "Read a file", "pending", {
    kind: "read",
    rawInput: { path: "/safe" },
    _meta: { mcpServerName: "pi-bridge", mcpToolName: "read" },
  }));
  notify(state, toolCallUpdate(toolCallId, { status: "in_progress" }));
  const result = await ask(state, "session/request_permission", {
    sessionId: state.id,
    toolCall: {
      toolCallId,
      title: "Read a file",
      kind: "read",
      status: "pending",
      rawInput: { path: "/safe" },
      _meta: { mcpServerName: "pi-bridge", mcpToolName: "read" },
      locations: [],
      content: [],
    },
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ],
  });
  const outcome = result?.result?.outcome;
  notify(state, message(`PERMISSION:${outcome?.outcome ?? "missing"}:${outcome?.optionId ?? ""}`));
}

async function prompt(state, id, params) {
  if (state.prompt) {
    respond(id, { stopReason: "cancelled" });
    return;
  }
  state.prompt = { id };
  const text = (params.prompt ?? []).map(part => part.text ?? part.resource?.text ?? "").join("");
  log({ event: "prompt", id, text: text.slice(0, 3000) });
  try {
    if (text.includes("EARLY_RESULT")) {
      notify(state, message("EARLY_END_CONTINUED"));
      finishPrompt(state, id, { stopReason: "end_turn" });
      return;
    }
    if (text.includes("NOTICE_TEST")) {
      notify(state, message("⚠ API error (attempt 1): reset"));
      notify(state, message("your previous response was cut off because it exceeded the output"));
      notify(state, message(" token limit please continue from where you left off, keeping your response shorter"));
      notify(state, thought("thinking"));
      notify(state, message("VISIBLE"));
      finishPrompt(state, id, { stopReason: "end_turn" });
      return;
    }
    if (text.includes("WIRE_IDENTITY_PERMISSION_TEST")) {
      await identityPermissionScript(state);
      finishPrompt(state, id, { stopReason: "end_turn" });
      return;
    }
    if (text.includes("WIRE_FORGED_PERMISSION_TEST")) {
      const result = await ask(state, "session/request_permission", {
        sessionId: state.id,
        toolCall: {
          toolCallId: "forged-call",
          title: "Read a file",
          kind: "read",
          status: "pending",
          rawInput: { path: "/safe" },
          _meta: { mcpServerName: "pi-bridge", mcpToolName: "read" },
          locations: [],
          content: [],
        },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      });
      const outcome = result?.result?.outcome;
      notify(state, message(`PERMISSION:${outcome?.outcome ?? "missing"}:${outcome?.optionId ?? ""}`));
      finishPrompt(state, id, { stopReason: "end_turn" });
      return;
    }
    if (text.includes("WIRE_CONFLICT_PERMISSION_TEST")) {
      const toolCallId = "conflict-call";
      notify(state, toolCall(toolCallId, "Read a file", "pending", {
        kind: "read",
        rawInput: { path: "/safe" },
        _meta: { mcpServerName: "pi-bridge", mcpToolName: "read" },
      }));
      const result = await ask(state, "session/request_permission", {
        sessionId: state.id,
        toolCall: {
          toolCallId,
          title: "Read a file",
          kind: "read",
          status: "pending",
          rawInput: { path: "/safe" },
          _meta: { mcpServerName: "other", mcpToolName: "read" },
          locations: [],
          content: [],
        },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      });
      const outcome = result?.result?.outcome;
      notify(state, message(`PERMISSION:${outcome?.outcome ?? "missing"}:${outcome?.optionId ?? ""}`));
      finishPrompt(state, id, { stopReason: "end_turn" });
      return;
    }
    if (text.includes("PERMISSION_TEST")) {
      await permissionScript(state);
      finishPrompt(state, id, { stopReason: "end_turn" });
      return;
    }
    if (text.includes("WIRE_CANCEL_TEST")) {
      notify(state, message("PARTIAL_CANCEL"));
      await new Promise(resolve => state.cancelWaiters.push(resolve));
      finishPrompt(state, id, { stopReason: "cancelled" });
      return;
    }
    if (text.includes("WIRE_REFUSAL_TEST")) {
      notify(state, message("I cannot help with that."));
      finishPrompt(state, id, { stopReason: "refusal" });
      return;
    }
    if (text.includes("WIRE_EMPTY_TEST")) {
      finishPrompt(state, id, { stopReason: "end_turn" });
      return;
    }
    if (text.includes("WIRE_THOUGHT_ONLY_TEST")) {
      notify(state, thought("thinking only"));
      finishPrompt(state, id, { stopReason: "end_turn" });
      return;
    }
    if (text.includes("WIRE_EARLY_END_TEST")) {
      await callTool(state, "pi_read", { path: "/early" });
      finishPrompt(state, id, { stopReason: "end_turn" });
      return;
    }
    if (text.includes("WIRE_COMPACTION_TEST")) {
      const pending = callTool(state, "pi_read", { path: "/compaction" });
      notify(state, {
        sessionUpdate: "compaction_update",
        compactionId: "compact-1",
        status: "started",
      });
      const result = await pending;
      notify(state, message(textOf(result)));
      finishPrompt(state, id, { stopReason: "end_turn" });
      return;
    }
    if (text.includes("WIRE_TOOL_BATCH_TEST")) {
      const [first, second] = await Promise.all([
        callToolWithRelay(state, "pi_read", { path: "/first" }),
        callToolWithRelay(state, "pi_read", { path: "/second" }),
      ]);
      notify(state, message(`FIRST:${textOf(first)}`));
      notify(state, message(`SECOND:${textOf(second)}`));
      finishPrompt(state, id, { stopReason: "end_turn" });
      return;
    }
    if (text.includes("WIRE_TOOL_ONLY_TEST")) {
      const result = await callTool(state, "pi_read", { path: "/tool-only" });
      notify(state, message(textOf(result)));
      finishPrompt(state, id, { stopReason: "end_turn" });
      return;
    }
    if (text.includes("WIRE_TOOLS_LIST_TEST")) {
      const server = state.servers.get("pi-bridge");
      if (!server) throw new Error("fake-agy has no pi-bridge MCP server");
      const { tools } = await server.client.listTools();
      notify(state, message(`TOOLS:${tools.map(tool => tool.name).join(",")}`));
      finishPrompt(state, id, { stopReason: "end_turn" });
      return;
    }
    if (text.includes("WIRE_TOOL_TEST")) {
      const result = await callToolWithRelay(state, "pi_read", { path: "/wire" });
      notify(state, message(`TOOL:${textOf(result)}`));
      finishPrompt(state, id, { stopReason: "end_turn" });
      return;
    }
    if (text.includes("WIRE_TOOL_ALIAS_TEST")) {
      const result = await callToolWithRelay(state, "pi_read", { file_path: "/wire-alias" });
      notify(state, message(`TOOL:${textOf(result)}`));
      finishPrompt(state, id, { stopReason: "end_turn" });
      return;
    }
    if (text.includes("WIRE_TOOL_MISSING_TEST")) {
      const result = await callTool(state, "pi_read", {});
      notify(state, message(`TOOL:${textOf(result)}`));
      finishPrompt(state, id, { stopReason: "end_turn" });
      return;
    }
    if (text.includes("Continue exactly where your previous output stopped")) {
      notify(state, message("CONTINUED"));
      finishPrompt(state, id, { stopReason: "end_turn" });
      return;
    }
    if (text.includes("MAX_TOKENS_TEST")) {
      notify(state, message("PARTIAL"));
      finishPrompt(state, id, { stopReason: "max_tokens" });
      return;
    }
    notify(state, message("FAKE_OK"));
    finishPrompt(state, id, { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } });
  } catch (error) {
    log({ event: "prompt-error", id, error: error instanceof Error ? error.message : String(error) });
    const detail = error instanceof Error ? error.message : String(error);
    debug(`prompt ${id} failed: ${detail}`);
    finishPrompt(state, id, { stopReason: "refusal" });
  }
}

async function handleMessage(incoming) {
  if (incoming.id !== undefined && incoming.method !== undefined) log({ event: "method", name: incoming.method });
  if (incoming.id !== undefined && incoming.method === undefined) {
    for (const state of sessions.values()) {
      const resolve = state.pending.get(incoming.id);
      if (!resolve) continue;
      state.pending.delete(incoming.id);
      resolve(incoming);
      return;
    }
    debug(`unknown response id ${incoming.id}`);
    return;
  }
  if (incoming.method === "initialize") {
    respond(incoming.id, {
      protocolVersion: 1,
      ...(process.env.FAKE_AGY_API_KEY_AUTH === "1" ? {
        authMethods: [{ id: "api-key", name: "Gemini API key", _meta: { "api-key": {} } }],
      } : {}),
      ...(modern ? { agentInfo: { name: agentName, title: agentName, version: "1.5.3" } } : {}),
      agentCapabilities: {
        promptCapabilities: { embeddedContext: true },
        ...(modern
          ? mcpHttpOverride === undefined ? {} : { mcpCapabilities: { http: mcpHttpOverride === "true" } }
          : { mcpCapabilities: { http: true } }),
        sessionCapabilities: {
          ...(process.env.FAKE_AGY_SESSION_LIST === "1" ? { list: {} } : {}),
        },
      },
    });
    return;
  }
  if (incoming.method === "session/new") {
    try {
      const state = await createSession(incoming.params ?? {});
      respond(incoming.id, sessionResponse(state));
    } catch (error) {
      respondError(incoming.id, -32603, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (incoming.method === "session/list") {
    if (process.env.FAKE_AGY_SESSION_LIST !== "1") {
      respondError(incoming.id, -32601, "Method not found");
      return;
    }
    respond(incoming.id, {
      sessions: [...sessions.values()].map(state => ({ sessionId: state.id, cwd: incoming.params?.cwd ?? process.cwd() })),
    });
    return;
  }
  if (incoming.method === "authenticate") {
    respond(incoming.id, {});
    return;
  }
  if (incoming.method === "session/set_mode" || incoming.method === "session/set_config_option") {
    if (!modern) {
      respond(incoming.id, {});
      return;
    }
    const state = sessions.get(incoming.params?.sessionId);
    if (!state) {
      respondError(incoming.id, -32602, "unknown session");
      return;
    }
    const configId = incoming.method === "session/set_mode" ? "mode" : incoming.params?.configId;
    const value = incoming.method === "session/set_mode" ? incoming.params?.modeId : incoming.params?.value;
    const choices = configId === "mode" ? modernModes : configId === "model" ? modernModels : undefined;
    if (!choices || typeof value !== "string" || !choices.some(choice => choice.value === value)) {
      respondError(incoming.id, -32602, `invalid ${String(configId)} selection ${String(value)}`);
      return;
    }
    if (configId === "mode") {
      state.mode = value;
      logMode(state, incoming.method);
    } else {
      state.model = value;
    }
    log({ event: "config", session: state.id, method: incoming.method, configId, value, configOptions: configOptions(state) });
    respond(incoming.id, { configOptions: configOptions(state) });
    return;
  }
  if (incoming.method === "session/cancel") {
    const state = sessions.get(incoming.params?.sessionId);
    if (state) cancelState(state);
    return;
  }
  if (incoming.method === "session/prompt") {
    const state = sessions.get(incoming.params?.sessionId);
    if (!state) {
      respondError(incoming.id, -32602, "unknown session");
      return;
    }
    void prompt(state, incoming.id, incoming.params ?? {});
    return;
  }
  if (incoming.id !== undefined) respondError(incoming.id, -32601, `Method not found: ${incoming.method}`);
}

async function shutdown() {
  for (const state of sessions.values()) {
    for (const connection of state.servers.values()) {
      await connection.client.close().catch(() => undefined);
    }
  }
  process.exit(0);
}

const input = createInterface({ input: process.stdin });
input.on("line", line => {
  if (!line.trim()) return;
  try {
    void handleMessage(JSON.parse(line));
  } catch (error) {
    debug(`bad frame: ${error instanceof Error ? error.message : String(error)}`);
  }
});
input.on("close", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
process.on("uncaughtException", error => {
  process.stderr.write(`fake-agy uncaught: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
process.on("unhandledRejection", error => {
  process.stderr.write(`fake-agy unhandled: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
