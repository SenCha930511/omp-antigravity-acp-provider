import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { RelayDelivery, hasUndeliveredRelay, relayNoticeCallId } from "../extension/runtime/tools/delivery.ts";
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
  assert.match(String(decision.batch?.blocks[0]?.text), /<tool_result id="call-1" name="read">/);
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
