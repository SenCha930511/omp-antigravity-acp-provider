// These scripts exercise explicit interruption/cancellation semantics.
process.env.OMP_ACP_STEER_MODE = "steer";
// Exercise the built upstream/runtime seam without Google calls or user data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AntigravityRuntime, PERMISSION_TOOL_NAME, PERMISSION_RESULT_KIND } from "../extension/runtime.mjs";

const model = { id: "gemini-3.8-flash", name: "Flash", api: "antigravity-acp", provider: "antigravity-acp",
  contextWindow: 524288, maxTokens: 32000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });
const modes = { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] };
const models = { currentModelId: model.id, availableModels: [{ modelId: model.id, name: "Flash" }] };
const connections: any[] = [];
let abortNext = false;
const saved = new Map<string, any>();
const runtime: any = new AntigravityRuntime(() => {
  const exit = Promise.withResolvers();
  const process = { alive: true, exited: exit.promise };
  const c = { process, prompts: [] as any[],
    async initialize() { return { protocolVersion: 1, agentCapabilities: { promptCapabilities: { embeddedContext: true } } }; },
    async newSession() { return { sessionId: randomUUID(), modes, models }; },
    getSessionState() { return { modes, models }; },
    async prompt(request: any) {
      c.prompts.push(request);
      if (abortNext) { abortNext = false; throw new DOMException("Cancelled by user", "AbortError"); }
      return { stopReason: "end_turn" };
    },
    async close() { process.alive = false; exit.resolve({ code: 0 }); },
  };
  connections.push(c); return c;
}, "yolo", { get: (id: string) => saved.get(id), save: (record: any) => saved.set(record.piSessionId, record),
  remove: (id: string) => saved.delete(id) });
async function turn(messages: any[], sid: string) {
  const events: any[] = [];
  for await (const event of runtime.stream(model, { messages, tools: [] }, { sessionId: sid }).stream) events.push(event);
  return events;
}
try {
  await turn([user("OLD_REQUEST")], "tools");
  const binding: any = [...runtime.resolvedBindings][0];
  binding.turnCompletion = Promise.resolve();
  let resumed = false;
  binding.pendingTools.set("old-call", {
    invocation: { id: "old-call", name: "read", arguments: {} },
    resolve(result: any) {
      if (result.isError) return;
      resumed = true;
      binding.writer.text("STALE_ANSWER_FROM_OLD_REQUEST");
      binding.writer.done("stop");
    },
  });
  const messages = [user("OLD_REQUEST"),
    { role: "assistant", provider: model.provider, model: model.id, api: model.api,
      content: [{ type: "toolCall", id: "old-call", name: "read", arguments: {} }], timestamp: 2 },
    { role: "toolResult", toolName: "read", toolCallId: "old-call", content: [{ type: "text", text: "OLD_RESULT" }], timestamp: 3 },
    user("NEW_REQUEST_AFTER_INTERRUPTION")];
  const events = await turn(messages, "tools");
  assert.equal(resumed, false, "A new user request must not resume the old pending tool turn");
  assert.ok(!JSON.stringify(events).includes("STALE_ANSWER_FROM_OLD_REQUEST"));
  assert.equal(connections[0].process.alive, false);
  assert.ok(JSON.stringify(connections.at(-1).prompts.at(-1)).includes("NEW_REQUEST_AFTER_INTERRUPTION"));

  await turn([user("NORMAL_REQUEST")], "normal");
  const normal: any = [...runtime.resolvedBindings].find((b: any) => b.key === "sid:normal");
  normal.turnCompletion = Promise.resolve();
  let normalResumed = false;
  normal.pendingTools.set("normal-call", { invocation: { id: "normal-call", name: "read", arguments: {} }, resolve(result: any) {
    if (result.isError) return;
    normalResumed = true; normal.writer.text("NORMAL_CONTINUATION"); normal.writer.done("stop");
  } });
  await turn([user("NORMAL_REQUEST"), { role: "toolResult", toolName: "read", toolCallId: "normal-call",
    content: [{ type: "text", text: "RESULT" }], timestamp: 2 }], "normal");
  assert.ok(normalResumed, "Genuine tool-result continuations must stay warm");

  await turn([user("OLD_PERMISSION_REQUEST")], "permission");
  const permission: any = [...runtime.resolvedBindings].find((b: any) => b.key === "sid:permission");
  permission.turnCompletion = Promise.resolve();
  let permissionResumed = false;
  permission.permission = { id: "permit-old", request: { options: [{ optionId: "allow" }] },
    timer: setTimeout(() => {}, 10_000).unref(), resolve(result: any) {
      if (result.outcome.outcome !== "selected") return;
      permissionResumed = true; permission.writer.text("STALE_PERMISSION_TURN"); permission.writer.done("stop");
    } };
  await turn([user("OLD_PERMISSION_REQUEST"), { role: "toolResult", toolName: PERMISSION_TOOL_NAME,
    toolCallId: "permit-old", content: [], details: { kind: PERMISSION_RESULT_KIND, requestId: "permit-old", cancelled: false, optionId: "allow" } },
    user("NEW_REQUEST_AFTER_PERMISSION")], "permission");
  assert.equal(permissionResumed, false, "An old approval must not swallow a newer user request");
  assert.ok(JSON.stringify(connections.at(-1).prompts.at(-1)).includes("NEW_REQUEST_AFTER_PERMISSION"));

  await turn([user("EDIT_ME")], "edit");
  const edited: any = [...runtime.resolvedBindings].find((b: any) => b.key === "sid:edit");
  edited.turnCompletion = Promise.resolve();
  let editedResumed = false;
  edited.pendingTools.set("edit-call", { invocation: { id: "edit-call", name: "read", arguments: {} }, resolve(result: any) {
    if (result.isError) return;
    editedResumed = true; edited.writer.done("stop");
  } });
  await turn([user("EDITED_NEW_REQUEST"), { role: "toolResult", toolName: "read", toolCallId: "edit-call", content: [] }], "edit");
  assert.equal(editedResumed, false, "Editing a user request must also invalidate the old continuation");

  abortNext = true;
  assert.ok((await turn([user("CANCEL_ME")], "abort")).some(e => e.type === "error"));
  const aborted = connections.at(-1);
  assert.equal(aborted.process.alive, false, "Abort must retire the old server session even if the transport still appears alive");
  assert.equal(saved.has("abort"), false, "Never resume a saved mapping from an aborted turn");
  await turn([user("CANCEL_ME"), user("NEW_AFTER_ABORT")], "abort");
  assert.notEqual(connections.at(-1), aborted);
  console.log("New/edited requests supersede pending tools and permissions; genuine continuations stay warm; aborted mappings are retired: PASS");
} finally { await runtime.close(); }
