import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type StopReason,
	type ToolCall,
} from "@earendil-works/pi-ai";

import { AntigravityAcpError, errorMessage } from "../acp/errors.js";
import { isJsonObject } from "./json.js";
import { emptyUsage } from "./usage.js";

export class PiEventWriter {
	readonly stream: AssistantMessageEventStream;
	readonly message: AssistantMessage;
	private open: { kind: "text" | "thinking"; index: number } | undefined;
	private started = false;
	private terminal = false;

	get finished(): boolean {
		return this.terminal;
	}

	constructor(model: Model<Api>) {
		this.stream = createAssistantMessageEventStream();
		this.message = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "pending",
			timestamp: Date.now(),
		};
	}

	text(delta: string): void {
		if (!delta || this.terminal) return;
		const index = this.ensureOpen("text");
		const block = this.message.content[index];
		if (!block || block.type !== "text") throw new Error("Pi text block invariant failed");
		block.text += delta;
		this.stream.push({ type: "text_delta", contentIndex: index, delta, partial: this.message });
	}

	thinking(delta: string): void {
		if (!delta || this.terminal) return;
		const index = this.ensureOpen("thinking");
		const block = this.message.content[index];
		if (!block || block.type !== "thinking") throw new Error("Pi thinking block invariant failed");
		block.thinking += delta;
		this.stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: this.message });
	}

	toolCall(id: string, name: string, args: Record<string, unknown>): void {
		if (this.terminal) return;
		if (!isJsonObject(args)) {
			throw new AntigravityAcpError("invalid_input", "Pi tool arguments must be a valid JSON object");
		}
		this.ensureStarted();
		this.closeOpen();
		const toolCall: ToolCall = { type: "toolCall", id, name, arguments: args };
		this.message.content.push(toolCall);
		const contentIndex = this.message.content.length - 1;
		this.stream.push({ type: "toolcall_start", contentIndex, partial: this.message });
		this.stream.push({
			type: "toolcall_delta",
			contentIndex,
			delta: JSON.stringify(args),
			partial: this.message,
		});
		this.stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: this.message });
	}

	done(reason: Extract<StopReason, "stop" | "length" | "toolUse">): void {
		if (this.terminal) return;
		this.ensureStarted();
		if (this.message.content.length === 0) this.ensureOpen("text");
		this.closeOpen();
		this.terminal = true;
		this.message.stopReason = reason;
		this.stream.push({ type: "done", reason, message: this.message });
		this.stream.end();
	}

	fail(cause: unknown, aborted = false): void {
		if (this.terminal) return;
		this.closeOpen();
		this.terminal = true;
		this.message.stopReason = aborted ? "aborted" : "error";
		this.message.errorMessage = errorMessage(cause);
		this.stream.push({
			type: "error",
			reason: aborted ? "aborted" : "error",
			error: this.message,
		});
		this.stream.end();
	}

	private ensureStarted(): void {
		if (this.started) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.message });
	}

	private ensureOpen(kind: "text" | "thinking"): number {
		if (this.open?.kind === kind) return this.open.index;
		this.closeOpen();
		this.ensureStarted();
		const index = this.message.content.length;
		if (kind === "text") {
			this.message.content.push({ type: "text", text: "" });
			this.stream.push({ type: "text_start", contentIndex: index, partial: this.message });
		} else {
			this.message.content.push({ type: "thinking", thinking: "" });
			this.stream.push({ type: "thinking_start", contentIndex: index, partial: this.message });
		}
		this.open = { kind, index };
		return index;
	}

	private closeOpen(): void {
		if (!this.open) return;
		const { kind, index } = this.open;
		this.open = undefined;
		const block = this.message.content[index];
		if (kind === "text" && block?.type === "text") {
			this.stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: this.message });
		} else if (kind === "thinking" && block?.type === "thinking") {
			this.stream.push({
				type: "thinking_end",
				contentIndex: index,
				content: block.thinking,
				partial: this.message,
			});
		}
	}
}
