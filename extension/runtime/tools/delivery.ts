import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { parseRelayCallId, TOOL_RELAY_CONTROL_NAME } from "../../tool-relay-protocol.mjs";
import type { TransferBlock } from "../prompt.ts";
import { projectedMcpName } from "./relay.ts";
import type { RelayInvocation, RelayOutcome } from "./relay.ts";

export interface DeliveryBoundary {
  readonly promptLive: boolean;
  readonly reusable: boolean;
  readonly prefixIntact: boolean;
  readonly newUserRequest: boolean;
  readonly arriving: ReadonlySet<string>;
  readonly images: boolean;
}

export interface DeliveryEntry {
  readonly callId: string;
  readonly toolName: string;
  readonly result: CallToolResult;
}

export interface DeliveryBatch {
  readonly id: number;
  readonly entries: readonly DeliveryEntry[];
  readonly blocks: readonly TransferBlock[];
}

export interface DeliveryDrop {
  readonly callId: string;
  readonly reason: string;
}

export interface DeliveryDecision {
  readonly batch?: DeliveryBatch;
  readonly deferred: readonly string[];
  readonly dropped: readonly DeliveryDrop[];
}

export interface RelayReader {
  inspect(callId: string): RelayOutcome;
}

type ObligationState = "open" | "claimed" | "delivered";

interface Obligation {
  readonly callId: string;
  readonly toolName: string;
  state: ObligationState;
  batchId?: number;
  // Kept so a binding replacement can hand a settled result to its successor.
  result?: CallToolResult;
}

export function hasUndeliveredRelay(delivery: Pick<RelayDelivery, "open">, callIds: Iterable<string>): boolean {
  const open = new Set(delivery.open());
  for (const callId of callIds) if (open.has(callId)) return true;
  return false;
}

const DEFAULT_MAX_ENVELOPE_BYTES = 96_000;

export function relayNoticeCallId(result: CallToolResult): string | undefined {
  if (result.isError) return undefined;
  const text = result.content
    .filter(block => block.type === "text")
    .map(block => block.type === "text" ? block.text : "")
    .join("");
  if (!text.startsWith("Tool still running.") || !text.includes(`Call ${TOOL_RELAY_CONTROL_NAME} with `)) return undefined;
  return parseRelayCallId(text);
}

export class RelayDelivery {
  private readonly obligations = new Map<string, Obligation>();
  private nextBatch = 1;

  constructor(
    private readonly relay: RelayReader,
    private readonly maxEnvelopeBytes = DEFAULT_MAX_ENVELOPE_BYTES,
  ) {}

  observe(invocation: RelayInvocation, noticeCallId: string | undefined): void {
    if (noticeCallId === undefined || noticeCallId !== invocation.id) return;
    if (this.obligations.has(invocation.id)) return;
    this.obligations.set(invocation.id, {
      callId: invocation.id,
      toolName: invocation.name,
      state: "open",
    });
  }

  consume(callId: string, result?: CallToolResult): void {
    if (result && relayNoticeCallId(result) === callId) return;
    const obligation = this.obligations.get(callId);
    if (!obligation || obligation.state === "delivered") return;
    if (obligation.result) {
      obligation.state = "delivered";
      return;
    }
    const outcome = this.relay.inspect(callId);
    if (outcome.kind === "settled") obligation.state = "delivered";
  }

  decide(boundary: DeliveryBoundary): DeliveryDecision {
    const dropped: DeliveryDrop[] = [];
    const deferred: string[] = [];
    const entries: DeliveryEntry[] = [];
    if (!boundary.reusable || !boundary.prefixIntact) {
      for (const obligation of this.obligations.values()) {
        if (obligation.state !== "open") continue;
        this.obligations.delete(obligation.callId);
        dropped.push({ callId: obligation.callId, reason: boundary.reusable ? "prefix-changed" : "binding-replaced" });
      }
      return { deferred, dropped };
    }
    for (const obligation of this.obligations.values()) {
      if (obligation.state !== "open") continue;
      const outcome = obligation.result
        ? { kind: "settled" as const, state: obligation.result.isError ? "failed" as const : "fulfilled" as const, result: obligation.result }
        : this.relay.inspect(obligation.callId);
      if (outcome.kind === "unknown" || outcome.kind === "expired" || outcome.kind === "cancelled") {
        this.obligations.delete(obligation.callId);
        dropped.push({ callId: obligation.callId, reason: `relay-${outcome.kind}` });
        continue;
      }
      if (outcome.kind === "outstanding") {
        deferred.push(obligation.callId);
        continue;
      }
      if (boundary.promptLive) {
        deferred.push(obligation.callId);
        continue;
      }
      if (boundary.arriving.has(obligation.callId)) {
        obligation.state = "delivered";
        continue;
      }
      obligation.result = outcome.result;
      entries.push({ callId: obligation.callId, toolName: obligation.toolName, result: outcome.result });
    }
    if (entries.length === 0) return { deferred, dropped };
    const id = this.nextBatch++;
    for (const entry of entries) {
      const obligation = this.obligations.get(entry.callId);
      if (obligation) {
        obligation.state = "claimed";
        obligation.batchId = id;
      }
    }
    const flavor = boundary.newUserRequest ? "preface" : "continuation";
    return {
      batch: {
        id,
        entries,
        blocks: toolResultEnvelope(entries, flavor, {
          images: boundary.images,
          maxBytes: this.maxEnvelopeBytes,
        }),
      },
      deferred,
      dropped,
    };
  }

  commit(batch: DeliveryBatch): void {
    for (const entry of batch.entries) {
      const obligation = this.obligations.get(entry.callId);
      if (obligation?.state === "claimed" && obligation.batchId === batch.id) obligation.state = "delivered";
    }
  }

  abandon(batch: DeliveryBatch): void {
    for (const entry of batch.entries) {
      const obligation = this.obligations.get(entry.callId);
      if (obligation?.state !== "claimed" || obligation.batchId !== batch.id) continue;
      obligation.state = "open";
      obligation.batchId = undefined;
    }
  }

  settledOpen(): DeliveryEntry[] {
    const entries: DeliveryEntry[] = [];
    for (const obligation of this.obligations.values()) {
      if (obligation.state === "delivered" || obligation.result === undefined) continue;
      entries.push({ callId: obligation.callId, toolName: obligation.toolName, result: obligation.result });
    }
    return entries;
  }

  adopt(entries: readonly DeliveryEntry[]): void {
    for (const entry of entries) {
      if (this.obligations.has(entry.callId)) continue;
      this.obligations.set(entry.callId, {
        callId: entry.callId,
        toolName: entry.toolName,
        state: "open",
        result: entry.result,
      });
    }
  }

  reset(): void {
    this.obligations.clear();
  }

  open(): readonly string[] {
    return [...this.obligations.values()].filter(item => item.state !== "delivered").map(item => item.callId);
  }
}

export function toolResultEnvelope(
  entries: readonly DeliveryEntry[],
  flavor: "continuation" | "preface",
  options: { readonly images: boolean; readonly maxBytes: number },
): TransferBlock[] {
  const share = entries.length > 0 ? Math.max(1, Math.floor(options.maxBytes / entries.length)) : options.maxBytes;
  const blocks: TransferBlock[] = [];
  for (const entry of entries) {
    const full = resultText(entry.result);
    const text = truncateUtf8(full, share);
    const truncated = text !== full;
    blocks.push({
      type: "text",
      text: `<tool_result id="${entry.callId}" name="${projectedMcpName(entry.toolName)}"${entry.result.isError ? ' error="true"' : ""}>\n` +
        `${escapeClosingTag(text)}${truncated ? "\n[tool result truncated for delivery]" : ""}\n</tool_result>\n\n`,
    });
    for (const block of entry.result.content) {
      if (block.type !== "image") continue;
      if (options.images) blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
      else blocks.push({ type: "text", text: `[image ${block.mimeType} omitted: this agent does not accept image input]` });
    }
  }
  if (flavor === "continuation") {
    blocks.push({ type: "text", text: "Continue the task with these tool results. These results are final for these call ids; do not call these tools again for them." });
  }
  return blocks;
}

function resultText(result: CallToolResult): string {
  return result.content
    .filter(block => block.type === "text")
    .map(block => block.type === "text" ? block.text : "")
    .join("\n");
}

function truncateUtf8(text: string, maxBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

function escapeClosingTag(text: string): string {
  return text.replaceAll("</tool_result>", "<\\/tool_result>");
}
