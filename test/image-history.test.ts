import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import {
	captureImageHistoryCheckpoint,
	matchesImageHistoryCheckpoint,
} from "../extension/runtime/image-history.ts";
import { AntigravityRuntime } from "../extension/runtime.mjs";

// The exact marker emitted by OMP (packages/coding-agent/src/session/
// provider-image-budget.ts) when an eviction empties a message.
const MARKER = { type: "text", text: "[image omitted: provider image limit]" };

const image = (data: string) => ({ type: "image", data, mimeType: "image/png" });
const text = (value: string) => ({ type: "text", text: value });
const user = (content: any) => ({ role: "user", content });

// Mirrors the runtime's boundary fingerprint: role plus content, and the tool
// identity for tool results. Extra host fields never participate.
const fingerprint = (message: any): string => createHash("sha256").update(JSON.stringify({
	role: message.role,
	content: message.content,
	...(message.role === "toolResult"
		? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError }
		: {}),
})).digest("hex");

// The official OMP transform: drop the oldest image blocks in message/content
// order, and substitute the exact marker when a message's content empties.
function clamp(messages: any[], drops: number, emptyMarker = true): any[] {
	let remaining = drops;
	return messages.map((message) => {
		if (!["user", "developer", "toolResult"].includes(message.role) || !Array.isArray(message.content)) return message;
		const kept: any[] = [];
		let changed = false;
		for (const block of message.content) {
			if (block?.type === "image" && remaining > 0) {
				remaining--;
				changed = true;
				continue;
			}
			kept.push(block);
		}
		if (!changed) return message;
		if (kept.length) return { ...message, content: kept };
		return { ...message, content: emptyMarker || message.role === "toolResult" ? [MARKER] : [] };
	});
}

test("a history without clampable images never produces a checkpoint", () => {
	const messages = [user([text("A")]), { role: "assistant", content: [text("B")] }];
	assert.equal(captureImageHistoryCheckpoint(messages, fingerprint), undefined);
	// An assistant image is never evicted, so it cannot justify a checkpoint.
	assert.equal(captureImageHistoryCheckpoint([
		{ role: "assistant", content: [image("A")] },
	], fingerprint), undefined);
});

test("a proven oldest-image eviction matches exactly", () => {
	const messages = [
		user([text("Q1"), image("A")]),
		{ role: "assistant", content: [text("A1")] },
		user([text("Q2"), image("B"), image("C")]),
	];
	const checkpoint = captureImageHistoryCheckpoint(messages, fingerprint);
	assert.ok(checkpoint);
	// Dropping only the oldest image is the official transform.
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, clamp(messages, 1), fingerprint), true);
	// Dropping every image is also one-way eviction.
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, clamp(messages, 3), fingerprint), true);
	// An untouched history is not an eviction.
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, messages, fingerprint), false);
});

test("dropping a newer image instead of the oldest does not match", () => {
	const messages = [user([text("Q"), image("A"), image("B")])];
	const checkpoint = captureImageHistoryCheckpoint(messages, fingerprint);
	assert.ok(checkpoint);
	const newestOnly = [user([text("Q"), image("A")])];
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, newestOnly, fingerprint), false);
});

test("evicting a newer message while an older image survives does not match", () => {
	const messages = [
		user([text("Q1"), image("A")]),
		user([text("Q2"), image("B")]),
	];
	const checkpoint = captureImageHistoryCheckpoint(messages, fingerprint);
	assert.ok(checkpoint);
	const newestDropped = [messages[0], user([text("Q2")])];
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, newestDropped, fingerprint), false);
});

test("text edits, image substitutions and tool identity changes never match", () => {
	const messages = [
		user([text("Q1"), image("A")]),
		{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [image("T")], isError: false },
	];
	const checkpoint = captureImageHistoryCheckpoint(messages, fingerprint);
	assert.ok(checkpoint);
	const editedText = clamp(messages, 1).map((message) =>
		message.role === "user" ? { ...message, content: [text("Q1 edited")] } : message);
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, editedText, fingerprint), false);
	// Same count, different image bytes: never an eviction.
	const substituted = [user([text("Q1"), image("A2")]), messages[1]];
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, substituted, fingerprint), false);
	const otherTool = clamp(messages, 1).map((message) =>
		message.role === "toolResult" ? { ...message, toolCallId: "call-2" } : message);
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, otherTool, fingerprint), false);
});

test("reordered blocks around a surviving image do not match", () => {
	const messages = [user([image("A"), text("T"), image("B")])];
	const checkpoint = captureImageHistoryCheckpoint(messages, fingerprint);
	assert.ok(checkpoint);
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, clamp(messages, 1), fingerprint), true);
	// Same blocks, same image, wrong order: the clamp never moves text.
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, [user([image("B"), text("T")])], fingerprint), false);
});

test("an image-only tool result matches only the exact omission marker", () => {
	const messages = [
		user([text("Q")]),
		{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [image("T")], isError: false },
	];
	const checkpoint = captureImageHistoryCheckpoint(messages, fingerprint);
	assert.ok(checkpoint);
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, clamp(messages, 1), fingerprint), true);
	// The host never leaves an emptied tool result empty.
	const empty = [messages[0], { ...messages[1], content: [] }];
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, empty, fingerprint), false);
	// Nor does it attach extra text to the marker.
	const padded = [messages[0], { ...messages[1], content: [MARKER, text("extra")] }];
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, padded, fingerprint), false);
});

test("an emptied user message matches both official marker generations", () => {
	const messages = [user([image("A")])];
	const checkpoint = captureImageHistoryCheckpoint(messages, fingerprint);
	assert.ok(checkpoint);
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, [user([MARKER])], fingerprint), true);
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, [user([])], fingerprint), true);
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, [user([text("replaced")])], fingerprint), false);
});

test("mixed text survives a full eviction unchanged", () => {
	const messages = [user([text("KEEP"), image("A")])];
	const checkpoint = captureImageHistoryCheckpoint(messages, fingerprint);
	assert.ok(checkpoint);
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, [user([text("KEEP")])], fingerprint), true);
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, [user([text("KEEP"), MARKER])], fingerprint), false);
});

test("exotic content shapes fail closed", () => {
	const plain = [user([text("Q"), image("A")])];
	const checkpoint = captureImageHistoryCheckpoint(plain, fingerprint);
	assert.ok(checkpoint);
	const proxied = new Proxy([text("Q")], {});
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, [{ role: "user", content: proxied }], fingerprint), false);
	assert.equal(captureImageHistoryCheckpoint([{ role: "user", content: proxied }], fingerprint), undefined);
	const sparse = [text("Q")] as any[];
	sparse[2] = text("T");
	assert.equal(captureImageHistoryCheckpoint([{ role: "user", content: sparse }], fingerprint), undefined);
	const accessor = [text("Q")];
	Object.defineProperty(accessor, "1", { get: () => image("A"), enumerable: true, configurable: true });
	assert.equal(captureImageHistoryCheckpoint([{ role: "user", content: accessor }], fingerprint), undefined);
	const extraKey = [text("Q"), image("A")] as any[];
	extraKey.note = "host";
	assert.equal(captureImageHistoryCheckpoint([{ role: "user", content: extraKey }], fingerprint), undefined);
	const foreignPrototype = Object.create(Array.prototype);
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, [{ role: "user", content: foreignPrototype }], fingerprint), false);
	// A proxied message array is never trusted either.
	assert.equal(captureImageHistoryCheckpoint(new Proxy([...plain], {}), fingerprint), undefined);
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, new Proxy([...plain], {}), fingerprint), false);
	// A length mismatch can never be image eviction.
	assert.equal(matchesImageHistoryCheckpoint(checkpoint, [...plain, user("more")], fingerprint), false);
});

test("checkpoint capture is bounded", () => {
	const manyImages = Array.from({ length: 257 }, () => user([image("A")]));
	assert.equal(captureImageHistoryCheckpoint(manyImages, fingerprint), undefined);
	const manyMessages = Array.from({ length: 4097 }, () => user("text"));
	assert.equal(captureImageHistoryCheckpoint(manyMessages, fingerprint), undefined);
});

test("the runtime keeps a warm session across an image eviction but rebuilds on a text edit", async () => {
	const model = {
		id: "gemini-3.8-flash", name: "Flash", api: "antigravity-acp", provider: "antigravity-acp",
		contextWindow: 524288, maxTokens: 32000, reasoning: false, input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const modes = { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] };
	const models = { currentModelId: model.id, availableModels: [{ modelId: model.id, name: "Flash" }] };
	const connections: any[] = [];
	const runtime = new AntigravityRuntime((options: any) => {
		const exit = Promise.withResolvers<any>();
		const process = { alive: true, exited: exit.promise };
		let id = randomUUID();
		const prompts: any[] = [];
		const connection = {
			process, prompts,
			async initialize() {
				return { protocolVersion: 1, agentCapabilities: { promptCapabilities: { embeddedContext: true, image: true } } };
			},
			async newSession() { id = randomUUID(); return { sessionId: id, modes, models }; },
			getSessionState() { return { modes, models }; },
			async prompt(request: any) {
				prompts.push(structuredClone(request));
				options.handlers.onUpdate({ sessionId: id, update: {
					sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ANSWER_${prompts.length}` } } });
				return { stopReason: "end_turn" };
			},
			async close() { if (!process.alive) return; process.alive = false; exit.resolve({ code: 0 }); },
		};
		connections.push(connection);
		return connection;
	}, "yolo");

	async function turn(messages: any[]) {
		const events: any[] = [];
		for await (const event of runtime.stream(model as any, { messages, tools: [] }, { sessionId: "image-evict" }).stream) {
			events.push(structuredClone(event));
		}
		const error = events.find((event) => event.type === "error");
		if (error) throw new Error(error.error.errorMessage);
		return events.find((event) => event.type === "done")?.message;
	}

	try {
		const first = user([text("QUESTION_ONE"), image("IMAGE_ONE")]);
		const answer = await turn([first]);
		assert.ok(answer, "first turn must answer");
		const assistant = {
			role: "assistant", provider: model.provider, model: model.id,
			content: answer.content.map((block: any) => ({ ...block })),
		};
		// OMP drops the oldest image from the outgoing context, then appends a turn.
		const evicted = [user([text("QUESTION_ONE")]), assistant, user("QUESTION_TWO")];
		await turn(evicted);
		assert.equal(connections.length, 1, "a proven image eviction must keep the warm ACP session");
		assert.equal(connections[0].prompts.length, 2, "only the unseen question is sent");
		assert.doesNotMatch(JSON.stringify(connections[0].prompts[1]), /QUESTION_ONE|IMAGE_ONE/);
		assert.match(JSON.stringify(connections[0].prompts[1]), /QUESTION_TWO/);

		// The same committed prefix with edited text is not eviction: rebuild.
		const secondAnswer = { role: "assistant", provider: model.provider, model: model.id,
			content: [{ type: "text", text: "ANSWER_2" }] };
		const edited = [user([text("QUESTION_ONE_EDITED")]), assistant, user("QUESTION_TWO"),
			secondAnswer, user("QUESTION_THREE")];
		await turn(edited);
		assert.equal(connections.length, 2, "a text edit must still rebuild the ACP session");
		assert.match(JSON.stringify(connections[1].prompts[0]), /QUESTION_ONE_EDITED/);
		assert.match(JSON.stringify(connections[1].prompts[0]), /QUESTION_THREE/);
	} finally {
		await runtime.close();
	}
});
