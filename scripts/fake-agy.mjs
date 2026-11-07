// Minimal ACP v1 agent over stdio for wire-level adapter tests. It never calls
// a model: prompt text selects a deterministic scripted response.
import { createInterface } from "node:readline";

const sessionId = "fake-session";
let nextRequest = 1;
const pending = new Map();
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const notify = update => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
const message = text => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const thought = text => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
const ask = (method, params) => new Promise(resolve => {
  const id = `server-${nextRequest++}`;
  pending.set(id, resolve);
  send({ jsonrpc: "2.0", id, method, params });
});

const session = () => ({
  sessionId,
  modes: { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] },
  models: { currentModelId: "gemini-3.8-flash", availableModels: [{ modelId: "gemini-3.8-flash", name: "Flash" }] },
});

async function prompt(id, params) {
  const text = (params.prompt ?? []).map(part => part.text ?? "").join("");
  if (text.includes("NOTICE_TEST")) {
    notify(message("⚠ API error (attempt 1): reset"));
    notify(message("your previous response was cut off because it exceeded the output"));
    notify(message(" token limit please continue from where you left off, keeping your response shorter"));
    notify(thought("thinking"));
    notify(message("VISIBLE"));
    return respond(id, { stopReason: "end_turn" });
  }
  if (text.includes("PERMISSION_TEST")) {
    const result = await ask("session/request_permission", {
      sessionId,
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
    notify(message(`PERMISSION:${outcome?.outcome ?? "missing"}:${outcome?.optionId ?? ""}`));
    return respond(id, { stopReason: "end_turn" });
  }
  if (text.includes("Continue exactly where your previous output stopped")) {
    notify(message("CONTINUED"));
    return respond(id, { stopReason: "end_turn" });
  }
  if (text.includes("MAX_TOKENS_TEST")) {
    notify(message("PARTIAL"));
    return respond(id, { stopReason: "max_tokens" });
  }
  notify(message("FAKE_OK"));
  return respond(id, { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } });
}

const input = createInterface({ input: process.stdin });
input.on("line", line => {
  if (!line.trim()) return;
  const incoming = JSON.parse(line);
  if (incoming.id !== undefined && incoming.method === undefined) {
    const resolve = pending.get(incoming.id);
    pending.delete(incoming.id);
    resolve?.(incoming);
    return;
  }
  if (incoming.method === "initialize") {
    return respond(incoming.id, {
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: { embeddedContext: true }, mcpCapabilities: { http: true } },
    });
  }
  if (incoming.method === "session/new") return respond(incoming.id, session());
  if (incoming.method === "session/set_mode") return respond(incoming.id, {});
  if (incoming.method === "session/set_config_option") return respond(incoming.id, {});
  if (incoming.method === "session/cancel") return;
  if (incoming.method === "session/prompt") {
    void prompt(incoming.id, incoming.params ?? {});
    return;
  }
  if (incoming.id !== undefined) respond(incoming.id, {});
});
