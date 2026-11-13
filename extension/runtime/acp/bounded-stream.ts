import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

export const DEFAULT_MAX_FRAME_BYTES = 32 * 1024 * 1024;

export interface BoundedNdjsonOptions {
	maxFrameBytes?: number;
	onProtocolError?: (error: Error) => void;
	onCompatibilityNoise?: (line: string) => void;
	closeOnProtocolError?: boolean;
}

/**
 * ACP SDK's stock NDJSON adapter is intentionally permissive and unbounded.
 * This adapter keeps the official connection implementation while enforcing a
 * hard per-frame limit and failing the transport on malformed protocol output.
 */
export function boundedNdjsonStream(
	output: WritableStream<Uint8Array>,
	input: ReadableStream<Uint8Array>,
	options: BoundedNdjsonOptions = {},
): Stream {
	const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
	if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1024) {
		throw new RangeError("maxFrameBytes must be a safe integer of at least 1024");
	}

	const encoder = new TextEncoder();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const readable = new ReadableStream<AnyMessage>({
		async start(controller) {
			const reader = input.getReader();
			let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					if (!value || value.byteLength === 0) continue;
					pending = appendBytes(pending, value);
					if (pending.byteLength > maxFrameBytes && pending.indexOf(0x0a) < 0) {
						throw new Error(`ACP frame exceeds ${maxFrameBytes} bytes`);
					}

					let newline: number;
					while ((newline = pending.indexOf(0x0a)) >= 0) {
						const frame = pending.subarray(0, newline);
						pending = pending.slice(newline + 1);
						if (frame.byteLength > maxFrameBytes) {
							throw new Error(`ACP frame exceeds ${maxFrameBytes} bytes`);
						}
						enqueueFrame(frame, decoder, controller, options.onCompatibilityNoise);
					}
				}

				if (pending.byteLength > 0) {
					if (pending.byteLength > maxFrameBytes) {
						throw new Error(`ACP frame exceeds ${maxFrameBytes} bytes`);
					}
					enqueueFrame(pending, decoder, controller, options.onCompatibilityNoise);
				}
				controller.close();
			} catch (cause) {
				const error = cause instanceof Error ? cause : new Error(String(cause));
				options.onProtocolError?.(error);
				// ACP SDK 0.16.1 starts its receive loop without observing the
				// returned promise. Closing lets its loop settle cleanly while the
				// connection races requests against onProtocolError.
				if (options.closeOnProtocolError) controller.close();
				else controller.error(error);
			} finally {
				reader.releaseLock();
			}
		},
	});

	const writable = new WritableStream<AnyMessage>({
		async write(message) {
			const bytes = encoder.encode(`${JSON.stringify(message)}\n`);
			if (bytes.byteLength > maxFrameBytes) {
				throw new Error(`Outbound ACP frame exceeds ${maxFrameBytes} bytes`);
			}
			const writer = output.getWriter();
			try {
				await writer.write(bytes);
			} finally {
				writer.releaseLock();
			}
		},
		async close() {
			const writer = output.getWriter();
			try {
				await writer.close();
			} finally {
				writer.releaseLock();
			}
		},
	});

	return { readable, writable };
}

function appendBytes(
	left: Uint8Array<ArrayBufferLike>,
	right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
	if (left.byteLength === 0) return right.slice();
	const joined = new Uint8Array(left.byteLength + right.byteLength);
	joined.set(left);
	joined.set(right, left.byteLength);
	return joined;
}

function enqueueFrame(
	bytes: Uint8Array<ArrayBufferLike>,
	decoder: TextDecoder,
	controller: ReadableStreamDefaultController<AnyMessage>,
	onCompatibilityNoise?: (line: string) => void,
): void {
	let text = decoder.decode(bytes);
	if (text.endsWith("\r")) text = text.slice(0, -1);
	if (!text.trim()) return;
	if (isKnownCompatibilityNoise(text)) {
		onCompatibilityNoise?.(text);
		return;
	}

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (cause) {
		throw new Error("Antigravity ACP emitted malformed JSON", { cause });
	}
	if (!isMessage(value)) throw new Error("Antigravity ACP emitted an invalid JSON-RPC message");
	controller.enqueue(value);
}

function isKnownCompatibilityNoise(text: string): boolean {
	// Chromium writes this exact status line to inherited stdout when an OAuth
	// URL is opened in an already-running browser. Antigravity currently lets
	// that child output share its otherwise NDJSON-only stdout stream.
	return text.trim() === "Opening in existing browser session.";
}

function isMessage(value: unknown): value is AnyMessage {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record.jsonrpc !== "2.0") return false;
	return typeof record.method === "string" || "id" in record;
}
