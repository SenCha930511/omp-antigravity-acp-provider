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
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let chunks: Uint8Array<ArrayBufferLike>[] = [];
	let chunkBytes = 0;
	let closed = false;
	let inputDone = false;
	const queuedFrames: Uint8Array<ArrayBufferLike>[] = [];
	let released = false;
	const releaseReader = () => {
		if (!reader || released) return;
		released = true;
		try { reader.releaseLock(); } catch { /* The stream is already released. */ }
	};
	const readable = new ReadableStream<AnyMessage>({
		start() {
			reader = input.getReader();
		},
		async pull(controller) {
			if (closed) return;
			try {
				for (;;) {
					while (queuedFrames.length > 0) {
						const frame = queuedFrames.shift()!;
						if (frame.byteLength > maxFrameBytes) {
							throw new Error(`ACP frame exceeds ${maxFrameBytes} bytes`);
						}
						enqueueFrame(frame, decoder, controller, options.onCompatibilityNoise);
						if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
					}
					if (inputDone) {
						closed = true;
						controller.close();
						releaseReader();
						return;
					}
					const { value, done } = await reader!.read();
					if (closed) return;
					if (done) {
						if (chunkBytes > 0) {
							if (chunkBytes > maxFrameBytes) {
								throw new Error(`ACP frame exceeds ${maxFrameBytes} bytes`);
							}
							const frame = chunks.length === 1 ? chunks[0]! : joinChunks(chunks, chunkBytes);
							chunks = [];
							chunkBytes = 0;
							queuedFrames.push(frame);
						}
						inputDone = true;
						continue;
					}
					if (!value || value.byteLength === 0) continue;
					let offset = 0;
					let newline = value.indexOf(0x0a, offset);
					if (newline < 0) {
						if (chunkBytes + value.byteLength > maxFrameBytes) {
							throw new Error(`ACP frame exceeds ${maxFrameBytes} bytes`);
						}
						chunks.push(value.slice());
						chunkBytes += value.byteLength;
						continue;
					}
					while (newline >= 0) {
						const tail = value.subarray(offset, newline);
						const frameLength = chunkBytes + tail.byteLength;
						if (frameLength > maxFrameBytes) {
							throw new Error(`ACP frame exceeds ${maxFrameBytes} bytes`);
						}
						let frame: Uint8Array<ArrayBufferLike>;
						if (chunks.length === 0) {
							frame = tail;
						} else {
							frame = new Uint8Array(frameLength);
							let cursor = 0;
							for (const part of chunks) {
								frame.set(part, cursor);
								cursor += part.byteLength;
							}
							if (tail.byteLength > 0) frame.set(tail, cursor);
							chunks = [];
							chunkBytes = 0;
						}
						queuedFrames.push(frame);
						offset = newline + 1;
						newline = offset < value.byteLength ? value.indexOf(0x0a, offset) : -1;
					}
					if (offset < value.byteLength) {
						const rest = value.subarray(offset);
						if (rest.byteLength > maxFrameBytes) {
							throw new Error(`ACP frame exceeds ${maxFrameBytes} bytes`);
						}
						chunks.push(rest.slice());
						chunkBytes = rest.byteLength;
					}
				}
			} catch (cause) {
				if (closed) return;
				closed = true;
				queuedFrames.length = 0;
				const error = cause instanceof Error ? cause : new Error(String(cause));
				options.onProtocolError?.(error);
				// ACP SDK 0.16.1 starts its receive loop without observing the
				// returned promise. Closing lets its loop settle cleanly while the
				// connection races requests against onProtocolError.
				if (options.closeOnProtocolError) controller.close();
				else controller.error(error);
				releaseReader();
			}
		},
		async cancel(reason) {
			closed = true;
			queuedFrames.length = 0;
			try { await reader?.cancel(reason); } catch { /* The input is already gone. */ }
			releaseReader();
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

function joinChunks(
	chunks: Uint8Array<ArrayBufferLike>[],
	totalBytes: number,
): Uint8Array<ArrayBufferLike> {
	if (chunks.length === 1) return chunks[0]!;
	const joined = new Uint8Array(totalBytes);
	let cursor = 0;
	for (const chunk of chunks) {
		joined.set(chunk, cursor);
		cursor += chunk.byteLength;
	}
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
