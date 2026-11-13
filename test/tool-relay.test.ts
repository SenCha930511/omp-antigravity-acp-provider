import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  ToolRelay,
  resolveRelayConfig,
  type RelayClock,
  projectedMcpName,
} from "../extension/tool-relay.ts";
import { parseRelayCallId, TOOL_RELAY_CONTROL_NAME } from "../extension/tool-relay-protocol.mjs";

class ManualClock implements RelayClock {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    this.timers.delete(timer as unknown as number);
  }

  advance(ms: number): void {
    this.time += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at > this.time) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }
}

const result = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: false,
});

const textOf = (value: CallToolResult): string => value.content
  .filter(block => block.type === "text")
  .map(block => block.type === "text" ? block.text : "")
  .join("");

const relayFor = (thresholdMs = 100) => {
  const clock = new ManualClock();
  const relay = new ToolRelay({ enabled: true, thresholdMs, fingerprint: `test:${thresholdMs}` }, clock);
  relay.beginTurn();
  return { clock, relay };
};

test("a result before the threshold returns directly", async () => {
  const { relay } = relayFor();
  const value = await relay.call(
    { id: "call-1", name: "read", arguments: { path: "/a" } },
    async () => result("done"),
  );
  assert.equal(textOf(value), "done");
  assert.equal(value.isError, false);
});

test("a slow call returns a relay notice and await gets the same result", async () => {
  const { clock, relay } = relayFor();
  const deferred = Promise.withResolvers<CallToolResult>();
  const call = relay.call(
    { id: "call-1", name: "read", arguments: { path: "/a" } },
    () => deferred.promise,
  );
  clock.advance(100);
  const notice = await call;
  assert.equal(notice.isError, false);
  assert.equal(parseRelayCallId(textOf(notice)), "call-1");

  const waiting = relay.await("call-1");
  clock.advance(100);
  const secondNotice = await waiting;
  assert.equal(parseRelayCallId(textOf(secondNotice)), "call-1");

  deferred.resolve(result("final"));
  const final = await relay.await("call-1");
  assert.equal(textOf(final), "final");
  assert.equal(final.isError, false);
});

test("the same tool and arguments dedup while pending", async () => {
  const { clock, relay } = relayFor();
  const deferred = Promise.withResolvers<CallToolResult>();
  let starts = 0;
  const start = () => {
    starts += 1;
    return deferred.promise;
  };
  const first = relay.call({ id: "call-1", name: "read", arguments: { path: "/a" } }, start);
  const second = relay.call({ id: "call-2", name: "read", arguments: { path: "/a" } }, start);
  clock.advance(100);
  const firstNotice = await first;
  const secondNotice = await second;
  assert.equal(starts, 1);
  assert.equal(parseRelayCallId(textOf(firstNotice)), "call-1");
  assert.equal(parseRelayCallId(textOf(secondNotice)), "call-1");
});

test("different arguments and completed calls are not deduped", async () => {
  const { relay } = relayFor();
  let starts = 0;
  const start = async () => {
    starts += 1;
    return result(`run-${starts}`);
  };
  await relay.call({ id: "call-1", name: "read", arguments: { path: "/a" } }, start);
  await relay.call({ id: "call-2", name: "read", arguments: { path: "/b" } }, start);
  await relay.call({ id: "call-3", name: "read", arguments: { path: "/a" } }, start);
  assert.equal(starts, 3);
});

test("unknown and expired call ids fail closed", async () => {
  const { relay } = relayFor();
  const unknown = await relay.await("missing");
  assert.equal(unknown.isError, true);
  const deferred = Promise.withResolvers<CallToolResult>();
  const call = relay.call({ id: "call-1", name: "read", arguments: {} }, () => deferred.promise);
  relay.beginTurn();
  relay.beginTurn();
  const expired = await relay.await("call-1");
  assert.equal(expired.isError, true);
  assert.match(textOf(expired), /expired/);
  deferred.resolve(result("late"));
  await call;
});

test("cancelAll settles current waiters and keeps the reason for later waits", async () => {
  const { clock, relay } = relayFor();
  const deferred = Promise.withResolvers<CallToolResult>();
  const call = relay.call({ id: "call-1", name: "read", arguments: {} }, () => deferred.promise);
  assert.equal(relay.pendingCount, 1);
  clock.advance(100);
  await call;
  assert.equal(relay.pendingCount, 1);

  const waiting = relay.await("call-1");
  relay.cancelAll("turn cancelled");
  const cancelled = await waiting;
  assert.equal(cancelled.isError, true);
  assert.match(textOf(cancelled), /turn cancelled/);

  const later = await relay.await("call-1");
  assert.equal(later.isError, true);
  assert.match(textOf(later), /turn cancelled/);
  assert.equal(relay.pendingCount, 0);

  deferred.resolve(result("late"));
  await Promise.resolve();
  assert.match(textOf(await relay.await("call-1")), /turn cancelled/);
});

test("cancelAll settles a call that is still waiting", async () => {
  const { relay } = relayFor(1_000);
  const deferred = Promise.withResolvers<CallToolResult>();
  const call = relay.call({ id: "call-1", name: "read", arguments: {} }, () => deferred.promise);
  relay.cancelAll("cancelled promptly");
  const cancelled = await call;
  assert.equal(cancelled.isError, true);
  assert.match(textOf(cancelled), /cancelled promptly/);
});

test("a threshold timeout cannot overwrite a cancellation in the same synchronous turn", async () => {
  const { clock, relay } = relayFor();
  const deferred = Promise.withResolvers<CallToolResult>();
  const call = relay.call({ id: "call-1", name: "read", arguments: {} }, () => deferred.promise);
  clock.advance(100);
  relay.cancelAll("cancelled after timeout");
  const cancelled = await call;
  assert.equal(cancelled.isError, true);
  assert.match(textOf(cancelled), /cancelled after timeout/);
  assert.match(textOf(await relay.await("call-1")), /cancelled after timeout/);
  deferred.resolve(result("late"));
  await Promise.resolve();
  assert.match(textOf(await relay.await("call-1")), /cancelled after timeout/);
});

test("an await timeout cannot overwrite a cancellation in the same synchronous turn", async () => {
  const { clock, relay } = relayFor();
  const deferred = Promise.withResolvers<CallToolResult>();
  relay.call({ id: "call-1", name: "read", arguments: {} }, () => deferred.promise);
  const waiting = relay.await("call-1");
  clock.advance(100);
  relay.cancelAll("cancelled after wait timeout");
  const cancelled = await waiting;
  assert.equal(cancelled.isError, true);
  assert.match(textOf(cancelled), /cancelled after wait timeout/);
  deferred.resolve(result("late"));
  await Promise.resolve();
  assert.match(textOf(await relay.await("call-1")), /cancelled after wait timeout/);
});

test("relay config accepts only 0 or 5000 through 165000", () => {
  assert.deepEqual(resolveRelayConfig({}), {
    enabled: true,
    thresholdMs: 85_000,
    fingerprint: "relay:1:85000",
  });
  assert.equal(resolveRelayConfig({ OMP_ACP_TOOL_RELAY_MS: "0" }).enabled, false);
  assert.equal(resolveRelayConfig({ OMP_ACP_TOOL_RELAY_MS: "5000" }).thresholdMs, 5_000);
  assert.equal(resolveRelayConfig({ OMP_ACP_TOOL_RELAY_MS: "165000" }).thresholdMs, 165_000);
  assert.throws(() => resolveRelayConfig({ OMP_ACP_TOOL_RELAY_MS: "4999" }));
  assert.throws(() => resolveRelayConfig({ OMP_ACP_TOOL_RELAY_MS: "165001" }));
  assert.throws(() => resolveRelayConfig({ OMP_ACP_TOOL_RELAY_MS: "abc" }));
});

test("the relay control name is reserved from projected user tools", () => {
  assert.equal(projectedMcpName("read"), "pi_read");
  assert.equal(projectedMcpName("omp_await_result"), TOOL_RELAY_CONTROL_NAME);
  assert.equal(projectedMcpName("bad name!"), "pi_bad_name_");
});
