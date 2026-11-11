import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";

import {
  TOOL_RELAY_CONTROL_NAME,
  TOOL_RELAY_PI_NAME,
  TOOL_RELAY_VERSION,
  relayNotice,
} from "./tool-relay-protocol.mjs";

export { TOOL_RELAY_CONTROL_NAME, TOOL_RELAY_PI_NAME, relayNotice };

export interface RelayConfig {
  enabled: boolean;
  thresholdMs: number;
  fingerprint: string;
}

export interface RelayInvocation {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

type Timer = ReturnType<typeof setTimeout>;

export interface RelayClock {
  setTimeout: (callback: () => void, ms: number) => Timer;
  clearTimeout: (timer: Timer) => void;
}

const systemClock: RelayClock = {
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: timer => clearTimeout(timer),
};

export function resolveRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const raw = env.OMP_ACP_TOOL_RELAY_MS;
  if (raw === undefined || raw.trim() === "") {
    return { enabled: true, thresholdMs: 85_000, fingerprint: `relay:${TOOL_RELAY_VERSION}:85000` };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error("OMP_ACP_TOOL_RELAY_MS must be 0 or an integer between 5000 and 165000");
  }
  if (value === 0) {
    return { enabled: false, thresholdMs: 0, fingerprint: `relay:${TOOL_RELAY_VERSION}:off` };
  }
  if (value < 5_000 || value > 165_000) {
    throw new Error("OMP_ACP_TOOL_RELAY_MS must be 0 or an integer between 5000 and 165000");
  }
  return { enabled: true, thresholdMs: value, fingerprint: `relay:${TOOL_RELAY_VERSION}:${value}` };
}

export const relayControlTool = {
  name: TOOL_RELAY_PI_NAME,
  description:
    "Wait for the same result of a tool call that returned a relay notice. " +
    "Use the call_id from that notice. Do not call the original tool again.",
  parameters: Type.Object({ call_id: Type.String({ minLength: 1 }) }),
};

type RelayState = "pending" | "relayed" | "fulfilled" | "failed" | "cancelled";

interface RelayRecord {
  callId: string;
  turn: number;
  name: string;
  argumentsKey: string;
  promise: Promise<CallToolResult>;
  state: RelayState;
  result?: CallToolResult;
}

interface WaitOutcome {
  timedOut: boolean;
  result?: CallToolResult;
}

export class ToolRelay {
  private readonly records = new Map<string, RelayRecord>();
  private turn = 0;

  constructor(
    private readonly config: RelayConfig,
    private readonly clock: RelayClock = systemClock,
  ) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  get thresholdMs(): number {
    return this.config.thresholdMs;
  }

  get pendingCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.state === "pending" || record.state === "relayed") count++;
    }
    return count;
  }

  beginTurn(): number {
    this.turn += 1;
    this.prune();
    return this.turn;
  }

  endTurn(): void {
    this.prune();
  }

  async call(invocation: RelayInvocation, start: () => Promise<CallToolResult>): Promise<CallToolResult> {
    if (!this.config.enabled) return start();
    const argumentsKey = canonicalArguments(invocation.arguments);
    const duplicate = this.findDuplicate(invocation.name, argumentsKey);
    if (duplicate) return relayNoticeResult(duplicate.callId);
    const callId = invocation.id || crypto.randomUUID();
    const promise = start();
    const record: RelayRecord = {
      callId,
      turn: this.turn,
      name: invocation.name,
      argumentsKey,
      promise,
      state: "pending",
    };
    this.records.set(callId, record);
    void promise.then(
      result => this.settle(record, result),
      () => this.settle(record, relayError("The original tool call failed before returning a result")),
    );
    const outcome = await this.wait(promise, this.config.thresholdMs);
    if (outcome.timedOut) {
      if (record.state === "pending") record.state = "relayed";
      return relayNoticeResult(callId);
    }
    return outcome.result ?? relayError("The original tool call returned no result");
  }

  async await(callId: string): Promise<CallToolResult> {
    if (!this.config.enabled) return relayError("Tool relay is disabled");
    const record = this.records.get(callId);
    if (!record) return relayError("Unknown or expired relay call id");
    if (record.turn < this.turn - 1) return relayError("Relay call id belongs to an expired turn");
    if (record.turn > this.turn) return relayError("Relay call id belongs to a future turn");
    if (record.state === "fulfilled" || record.state === "failed" || record.state === "cancelled") {
      return record.result ?? relayError("The original tool call has no result");
    }
    const outcome = await this.wait(record.promise, this.config.thresholdMs);
    if (outcome.timedOut) {
      if (record.state === "pending") record.state = "relayed";
      return relayNoticeResult(callId);
    }
    return outcome.result ?? relayError("The original tool call returned no result");
  }

  cancelAll(reason: string): void {
    for (const record of this.records.values()) {
      if (record.state === "pending" || record.state === "relayed") {
        record.state = "cancelled";
        record.result = relayError(reason);
      }
    }
    this.records.clear();
  }

  private settle(record: RelayRecord, result: CallToolResult): void {
    if (record.state === "cancelled") return;
    record.state = result.isError ? "failed" : "fulfilled";
    record.result = result;
  }

  private findDuplicate(name: string, argumentsKey: string): RelayRecord | undefined {
    for (const record of this.records.values()) {
      if (record.turn !== this.turn) continue;
      if (record.state !== "pending" && record.state !== "relayed") continue;
      if (record.name === name && record.argumentsKey === argumentsKey) return record;
    }
    return undefined;
  }

  private wait(promise: Promise<CallToolResult>, ms: number): Promise<WaitOutcome> {
    return new Promise(resolve => {
      let settled = false;
      const finish = (outcome: WaitOutcome) => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        resolve(outcome);
      };
      const timer = this.clock.setTimeout(() => finish({ timedOut: true }), ms);
      promise.then(
        result => finish({ timedOut: false, result }),
        () => finish({ timedOut: false, result: relayError("The original tool call failed before returning a result") }),
      );
    });
  }

  private prune(): void {
    for (const [callId, record] of this.records) {
      if (record.turn >= this.turn) continue;
      if (record.state === "pending" || record.state === "relayed") continue;
      this.records.delete(callId);
    }
  }
}

export function relayError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
export function relayNoticeResult(callId: string): CallToolResult {
  return { content: [{ type: "text", text: relayNotice(callId) }], isError: false };
}
export function projectedMcpName(name: string): string {
  return `pi_${name}`.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 64);
}

export function canonicalArguments(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalArguments).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalArguments(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
