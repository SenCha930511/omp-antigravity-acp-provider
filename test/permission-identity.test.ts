import assert from "node:assert/strict";
import test from "node:test";

import { PermissionIdentityRegistry } from "../extension/permission-identity.ts";

const options = [
  { optionId: "allow_once", kind: "allow_once" },
  { optionId: "reject_once", kind: "reject_once" },
  { optionId: "allow_always", kind: "allow_always" },
];

const request = (toolCall: Record<string, unknown>, choices = options) => ({
  sessionId: "s1",
  toolCall,
  options: choices,
});

const toolCall = (id: string, extra: Record<string, unknown> = {}) => ({
  toolCallId: id,
  title: "Read a file",
  kind: "read",
  rawInput: { path: "/safe" },
  ...extra,
});

test("matching structured update and permission pass to host review", () => {
  const registry = new PermissionIdentityRegistry();
  registry.beginTurn("s1", 1);
  registry.record("s1", 1, {
    sessionUpdate: "tool_call",
    ...toolCall("call-1", { _meta: { mcpServerName: "pi-bridge", mcpToolName: "read" } }),
  });
  assert.equal(registry.check("s1", 1, request(toolCall("call-1", {
    _meta: { mcpServerName: "pi-bridge", mcpToolName: "read" },
  }))), undefined);
});

test("a status-only update keeps the prior identity", () => {
  const registry = new PermissionIdentityRegistry();
  registry.beginTurn("s1", 1);
  registry.record("s1", 1, {
    sessionUpdate: "tool_call",
    ...toolCall("call-1", { mcpServerName: "pi-bridge", mcpToolName: "read" }),
  });
  registry.record("s1", 1, { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress" });
  assert.equal(registry.check("s1", 1, request(toolCall("call-1"))), undefined);
});

test("an explicit null clears identity and marks a conflict", () => {
  const registry = new PermissionIdentityRegistry();
  registry.beginTurn("s1", 1);
  registry.record("s1", 1, {
    sessionUpdate: "tool_call",
    ...toolCall("call-1", { _meta: { mcpServerName: "pi-bridge", mcpToolName: "read" } }),
  });
  registry.record("s1", 1, {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    _meta: { mcpServerName: null },
  });
  const decision = registry.check("s1", 1, request(toolCall("call-1")));
  assert.deepEqual(decision, { outcome: { outcome: "selected", optionId: "reject_once" } });
});

test("a changed server or tool is rejected", () => {
  const registry = new PermissionIdentityRegistry();
  registry.beginTurn("s1", 1);
  registry.record("s1", 1, {
    sessionUpdate: "tool_call",
    ...toolCall("call-1", { _meta: { mcpServerName: "pi-bridge", mcpToolName: "read" } }),
  });
  const changedServer = registry.check("s1", 1, request(toolCall("call-1", {
    _meta: { mcpServerName: "other", mcpToolName: "read" },
  })));
  assert.equal(changedServer?.outcome.outcome, "selected");
  const changedTool = registry.check("s1", 1, request(toolCall("call-1", {
    _meta: { mcpServerName: "pi-bridge", mcpToolName: "bash" },
  })));
  assert.equal(changedTool?.outcome.outcome, "selected");
});

test("a permission before any update is rejected only when it claims MCP identity", () => {
  const registry = new PermissionIdentityRegistry();
  registry.beginTurn("s1", 1);
  assert.equal(registry.check("s1", 1, request(toolCall("call-1"))), undefined);
  const claimed = registry.check("s1", 1, request(toolCall("call-1", {
    _meta: { mcpServerName: "pi-bridge", mcpToolName: "read" },
  })));
  assert.deepEqual(claimed, { outcome: { outcome: "selected", optionId: "reject_once" } });
});

test("title, name and rawInput are not identity evidence", () => {
  const registry = new PermissionIdentityRegistry();
  registry.beginTurn("s1", 1);
  registry.record("s1", 1, {
    sessionUpdate: "tool_call",
    ...toolCall("call-1", { _meta: { mcpServerName: "pi-bridge", mcpToolName: "read" } }),
  });
  assert.equal(registry.check("s1", 1, request({
    ...toolCall("call-1", { name: "bash", title: "Forged", rawInput: { command: "rm -rf /" } }),
  })), undefined);
});

test("a previous-turn tool call id is rejected", () => {
  const registry = new PermissionIdentityRegistry();
  registry.beginTurn("s1", 1);
  registry.record("s1", 1, { sessionUpdate: "tool_call", ...toolCall("call-1") });
  registry.beginTurn("s1", 2);
  const decision = registry.check("s1", 2, request(toolCall("call-1")));
  assert.deepEqual(decision, { outcome: { outcome: "selected", optionId: "reject_once" } });
  assert.equal(registry.check("s1", 2, request(toolCall("call-2"))), undefined);
});

test("a rejection without reject_once is cancelled and never allow_always", () => {
  const registry = new PermissionIdentityRegistry();
  registry.beginTurn("s1", 1);
  const decision = registry.check("s1", 1, request(toolCall("call-1", {
    _meta: { mcpServerName: "pi-bridge" },
  }), [
    { optionId: "allow_always", kind: "allow_always" },
  ]));
  assert.deepEqual(decision, { outcome: { outcome: "cancelled" } });
});

test("top-level and _meta aliases agree without conflict", () => {
  const registry = new PermissionIdentityRegistry();
  registry.beginTurn("s1", 1);
  registry.record("s1", 1, {
    sessionUpdate: "tool_call",
    ...toolCall("call-1", {
      mcpServerName: "pi-bridge",
      mcpToolName: "read",
      _meta: { serverName: "pi-bridge", toolName: "read" },
    }),
  });
  assert.equal(registry.check("s1", 1, request(toolCall("call-1", {
    _meta: { server: "pi-bridge", tool: "read" },
  }))), undefined);
});

test("sessions do not share identity records", () => {
  const registry = new PermissionIdentityRegistry();
  registry.beginTurn("s1", 1);
  registry.record("s1", 1, {
    sessionUpdate: "tool_call",
    ...toolCall("call-1", { _meta: { mcpServerName: "pi-bridge" } }),
  });
  assert.equal(registry.check("s2", 1, request(toolCall("call-1"))), undefined);
});

test("a late update cannot re-register a previous-turn tool call id", () => {
  const registry = new PermissionIdentityRegistry();
  registry.beginTurn("s1", 1);
  registry.record("s1", 1, { sessionUpdate: "tool_call", ...toolCall("call-1") });
  registry.beginTurn("s1", 2);
  registry.record("s1", 2, { sessionUpdate: "tool_call", ...toolCall("call-1") });
  const decision = registry.check("s1", 2, request(toolCall("call-1")));
  assert.deepEqual(decision, { outcome: { outcome: "selected", optionId: "reject_once" } });
});
