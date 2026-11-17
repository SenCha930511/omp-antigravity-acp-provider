import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { RelayDelivery, hasUndeliveredRelay, relayNoticeCallId, toolResultEnvelope } from "../extension/runtime/tools/delivery.ts";
import type { RelayOutcome } from "../extension/runtime/tools/relay.ts";
import { relayNotice } from "../extension/tool-relay-protocol.mjs";

const result = (text: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text }],
  isError,
});

const boundary = (overrides: Partial<Parameters<RelayDelivery["decide"]>[0]> = {}) => ({
  promptLive: false,
  reusable: true,
  prefixIntact: true,
  newUserRequest: false,
  arriving: new Set<string>(),
  images: false,
  ...overrides,
});

const setup = (outcomes: Map<string, RelayOutcome>) => {
  const delivery = new RelayDelivery({ inspect: callId => outcomes.get(callId) ?? { kind: "unknown" } }, 4096);
  delivery.observe({ id: "call-1", name: "read", arguments: { path: "/a" } }, "call-1");
  return delivery;
};

test("a completed unawaited result becomes one prompt envelope and is committed once", () => {
  const outcomes = new Map<string, RelayOutcome>([
    ["call-1", { kind: "settled", state: "fulfilled", result: result("done") }],
  ]);
  const delivery = setup(outcomes);
  const decision = delivery.decide(boundary());
  assert.equal(decision.batch?.entries.length, 1);
  assert.match(String(decision.batch?.blocks[0]?.text), /<tool_result id="call-1" name="omp_read">/);
  assert.match(String(decision.batch?.blocks[0]?.text), /done/);
  assert.equal(delivery.open().length, 1, "a claimed batch is not delivered until commit");
  delivery.commit(decision.batch!);
  assert.deepEqual(delivery.open(), []);
  delivery.commit(decision.batch!);
  assert.deepEqual(delivery.open(), []);
});

test("a result already in the prompt delta is history, not an envelope", () => {
  const outcomes = new Map<string, RelayOutcome>([
    ["call-1", { kind: "settled", state: "fulfilled", result: result("done") }],
  ]);
  const delivery = setup(outcomes);
  const decision = delivery.decide(boundary({ arriving: new Set(["call-1"]) }));
  assert.equal(decision.batch, undefined);
  assert.deepEqual(delivery.open(), []);
});

test("a live prompt keeps the obligation open", () => {
  const outcomes = new Map<string, RelayOutcome>([
    ["call-1", { kind: "settled", state: "fulfilled", result: result("done") }],
  ]);
  const delivery = setup(outcomes);
  const decision = delivery.decide(boundary({ promptLive: true }));
  assert.equal(decision.batch, undefined);
  assert.deepEqual(delivery.open(), ["call-1"]);
});

test("awaiting the result consumes the obligation", () => {
  const outcomes = new Map<string, RelayOutcome>([
    ["call-1", { kind: "settled", state: "fulfilled", result: result("done") }],
  ]);
  const delivery = setup(outcomes);
  delivery.consume("call-1");
  assert.deepEqual(delivery.open(), []);
  assert.equal(delivery.decide(boundary()).batch, undefined);
});

test("consume ignores a relay notice even if the relay settles immediately", () => {
  const outcomes = new Map<string, RelayOutcome>([
    ["call-1", { kind: "settled", state: "fulfilled", result: result("done") }],
  ]);
  const delivery = setup(outcomes);
  delivery.consume("call-1", { content: [{ type: "text", text: relayNotice("call-1") }], isError: false });
  assert.deepEqual(delivery.open(), ["call-1"]);
  delivery.consume("call-1", result("done"));
  assert.deepEqual(delivery.open(), []);

  const external = setup(outcomes);
  external.consume("call-1", result('{"call_id":"external-job-7","status":"done"}'));
  assert.deepEqual(external.open(), []);
});

test("expired and cancelled results are dropped", () => {
  const outcomes = new Map<string, RelayOutcome>([
    ["call-1", { kind: "cancelled", reason: "aborted" }],
  ]);
  const delivery = setup(outcomes);
  const decision = delivery.decide(boundary());
  assert.equal(decision.batch, undefined);
  assert.deepEqual(decision.dropped, [{ callId: "call-1", reason: "relay-cancelled" }]);
  assert.deepEqual(delivery.open(), []);
});

test("an abandoned batch can be retried", () => {
  const outcomes = new Map<string, RelayOutcome>([
    ["call-1", { kind: "settled", state: "fulfilled", result: result("done") }],
  ]);
  const delivery = setup(outcomes);
  const decision = delivery.decide(boundary());
  delivery.abandon(decision.batch!);
  assert.deepEqual(delivery.open(), ["call-1"]);
  assert.ok(delivery.decide(boundary()).batch);
});

test("a new user request gets a preface without a continuation instruction", () => {
  const outcomes = new Map<string, RelayOutcome>([
    ["call-1", { kind: "settled", state: "fulfilled", result: result("done") }],
  ]);
  const delivery = setup(outcomes);
  const decision = delivery.decide(boundary({ newUserRequest: true }));
  const text = decision.batch?.blocks.map(block => block.text ?? "").join("\n") ?? "";
  assert.match(text, /<tool_result/);
  assert.doesNotMatch(text, /Continue the task with these tool results/);
});

test("a failed result is delivered as an error envelope", () => {
  const outcomes = new Map<string, RelayOutcome>([
    ["call-1", { kind: "settled", state: "failed", result: result("boom", true) }],
  ]);
  const delivery = setup(outcomes);
  const decision = delivery.decide(boundary());
  assert.match(String(decision.batch?.blocks[0]?.text), /error="true"/);
  assert.match(String(decision.batch?.blocks[0]?.text), /boom/);
});

test("relay notice parsing ignores real results and reads the call id", () => {
  assert.equal(relayNoticeCallId(result("real")), undefined);
  assert.equal(relayNoticeCallId(result('{"call_id":"external-job-7","status":"done"}')), undefined);
  assert.equal(relayNoticeCallId({ content: [{ type: "text", text: relayNotice("call-9") }], isError: false }), "call-9");
});

test("hasUndeliveredRelay detects open and claimed obligations", () => {
  const outcomes = new Map<string, RelayOutcome>([
    ["call-1", { kind: "settled", state: "fulfilled", result: result("done") }],
  ]);
  const delivery = setup(outcomes);
  assert.equal(hasUndeliveredRelay(delivery, ["call-1"]), true);
  assert.equal(hasUndeliveredRelay(delivery, ["call-2"]), false);
  const batch = delivery.decide(boundary()).batch!;
  assert.equal(hasUndeliveredRelay(delivery, ["call-1"]), true, "a claimed batch is not delivered yet");
  delivery.commit(batch);
  assert.equal(hasUndeliveredRelay(delivery, ["call-1"]), false);
});


test("envelope truncation counts UTF-8 bytes without splitting astral characters", () => {
  const blocks = toolResultEnvelope([{
    callId: "call-1",
    toolName: "read",
    result: result("😀😀"),
  }], "continuation", { images: false, maxBytes: 4 });
  const text = String(blocks[0]?.text);
  assert.match(text, /😀/);
  assert.doesNotMatch(text, /�/);
  assert.doesNotMatch(text, /😀😀/);
});

test("the envelope names the projected omp_ tool the model actually sees", () => {
  const blocks = toolResultEnvelope([{
    callId: "call-1",
    toolName: "read",
    result: result("done"),
  }], "continuation", { images: false, maxBytes: 96_000 });
  assert.match(String(blocks[0]?.text), /<tool_result id="call-1" name="omp_read">/);

  const projected = toolResultEnvelope([{
    callId: "call-2",
    toolName: "mcp.some tool",
    result: result("done"),
  }], "continuation", { images: false, maxBytes: 96_000 });
  assert.match(String(projected[0]?.text), /<tool_result id="call-2" name="omp_mcp_some_tool">/);
});
