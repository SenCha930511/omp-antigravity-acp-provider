import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HistorySeedError, HistorySeedGuard } from "../extension/runtime/history-seed.ts";
import { AntigravityRuntime } from "../extension/runtime.mjs";

const abortable = (signal: AbortSignal): Promise<never> => new Promise((_, reject) => {
	signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

test("an exact trimmed OK acknowledgement passes", () => {
	const guard = new HistorySeedGuard();
	guard.appendText("  OK\n");
	assert.equal(guard.text, "  OK\n");
	guard.assertAcknowledged();
});

test("anything but the exact OK is rejected with a compact-history hint", () => {
	const guard = new HistorySeedGuard();
	guard.appendText("OKAY");
	assert.throws(() => guard.assertAcknowledged(), (error: unknown) =>
		error instanceof HistorySeedError && /did not acknowledge with OK/.test(error.message) &&
		/Compact OMP history/.test(error.message));
	const empty = new HistorySeedGuard();
	assert.throws(() => empty.assertAcknowledged(), HistorySeedError);
	const quotaNotice = new HistorySeedGuard();
	quotaNotice.appendText("Usage Limit Reached\n\nYou have reached your current quota for this period.");
	// The runtime checks quota before this assertion, so the guard stays exact.
	assert.throws(() => quotaNotice.assertAcknowledged(), /did not acknowledge with OK/);
});

test("captured text is bounded", () => {
	const guard = new HistorySeedGuard();
	guard.appendText("x".repeat(5000));
	assert.equal(guard.text.length, 4096);
	guard.appendText("y".repeat(100));
	assert.equal(guard.text.length, 4096);
	assert.equal(guard.text.endsWith("y"), false);
});

test("a tool attempt aborts the in-flight step and fails it", async () => {
	const guard = new HistorySeedGuard();
	let child: AbortSignal | undefined;
	const pending = guard.run((signal) => {
		child = signal;
		return abortable(signal);
	});
	guard.rejectTool();
	await assert.rejects(pending, (error: unknown) =>
		error instanceof HistorySeedError && /requested a tool or permission/.test(error.message));
	assert.equal(child?.aborted, true);
	// The recorded failure survives a later successful-looking reply.
	guard.appendText("OK");
	assert.throws(() => guard.assertAcknowledged(), /requested a tool or permission/);
});

test("a step that never acknowledges hits the bounded production default deadline", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const guard = new HistorySeedGuard();
	let aborted = false;
	const pending = guard.run((signal) => {
		signal.addEventListener("abort", () => { aborted = true; }, { once: true });
		return abortable(signal);
	});
	t.mock.timers.tick(59_999);
	assert.equal(aborted, false);
	t.mock.timers.tick(1);
	await assert.rejects(pending, (error: unknown) =>
		error instanceof HistorySeedError && /acknowledgement deadline/.test(error.message));
	assert.equal(aborted, true);
});

test("a parent abort keeps its exact reason and aborts the child", async () => {
	const controller = new AbortController();
	const guard = new HistorySeedGuard(controller.signal);
	const reason = new Error("user cancelled during seed step");
	let child: AbortSignal | undefined;
	const pending = guard.run((signal) => {
		child = signal;
		return abortable(signal);
	});
	controller.abort(reason);
	await assert.rejects(pending, (error: unknown) => error === reason);
	assert.equal(child?.aborted, true);
	assert.equal(child?.reason, reason);
});

test("an already aborted parent never starts the request", async () => {
	const controller = new AbortController();
	const reason = new Error("cancelled before the seed");
	controller.abort(reason);
	const guard = new HistorySeedGuard(controller.signal);
	let started = false;
	await assert.rejects(guard.run(() => { started = true; return Promise.resolve("OK"); }), (error: unknown) => error === reason);
	assert.equal(started, false);
});

test("disposal rejects the in-flight step and aborts it", async () => {
	const guard = new HistorySeedGuard();
	let child: AbortSignal | undefined;
	const pending = guard.run((signal) => {
		child = signal;
		return abortable(signal);
	});
	guard.dispose();
	await assert.rejects(pending, (error: unknown) =>
		error instanceof HistorySeedError && /guard was disposed/.test(error.message));
	assert.equal(child?.aborted, true);
	// A disposed guard accepts no new step and no more text.
	guard.appendText("OK");
	assert.equal(guard.text, "");
	await assert.rejects(guard.run(() => Promise.resolve("OK")), /guard was disposed/);
});

test("a guard runs exactly one step", async () => {
	const guard = new HistorySeedGuard();
	assert.equal(await guard.run(() => Promise.resolve("value")), "value");
	await assert.rejects(guard.run(() => Promise.resolve("again")), /already started/);
});

// A history large enough that OMP must replay it through hidden seed steps.
const user = (content: string) => ({ role: "user", content, timestamp: 1 });
const SEEDED = [
	user("HISTORY_PART_ONE_" + "a".repeat(120_000)),
	user("HISTORY_PART_TWO_" + "b".repeat(120_000)),
	user("FINAL_QUESTION"),
];
const lastText = (request: any): string => request.prompt
	.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");

async function fixture() {
	const model = { id: "gemini-3.8-flash", name: "Flash", api: "antigravity-acp", provider: "antigravity-acp",
		contextWindow: 524288, maxTokens: 32000, reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const modes = { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] };
	const models = { currentModelId: model.id, availableModels: [{ modelId: model.id, name: "Flash" }] };
	const connections: any[] = [];
	const actions: string[] = [];
	const runtime = new AntigravityRuntime((options: any) => {
		const exit = Promise.withResolvers<any>();
		const process = { alive: true, exited: exit.promise };
		let id = randomUUID();
		const connection: any = {
			process, prompts: [], toolResults: [],
			async initialize() {
				return { protocolVersion: 1, agentCapabilities: { promptCapabilities: { embeddedContext: true } } };
			},
			async newSession() { id = randomUUID(); return { sessionId: id, modes, models }; },
			getSessionState() { return { modes, models }; },
			async prompt(request: any) {
				connection.prompts.push(structuredClone(request));
				const seed = lastText(request).endsWith("Reply only with: OK");
				const action = seed ? actions.shift() : undefined;
				if (action === "tool") {
					options.handlers.onUpdate({ sessionId: id, update: {
						sessionUpdate: "tool_call", toolCallId: "seed-tool", title: "Seed tool", status: "in_progress" } });
					return { stopReason: "end_turn" };
				}
				if (action === "permission") {
					await options.handlers.onPermission({ sessionId: id,
						toolCall: { toolCallId: "seed-permission", title: "Seed permission" },
						options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] });
					return { stopReason: "end_turn" };
				}
				if (action === "mcp") {
					const binding = [...runtime.resolvedBindings].find((candidate: any) => candidate.session.sessionId === id);
					const result = await runtime.requestPiTool(binding, { id: "seed-mcp", name: "read", arguments: {} });
					connection.toolResults.push(result);
					return { stopReason: "end_turn" };
				}
				if (action === "not-ok") {
					options.handlers.onUpdate({ sessionId: id, update: {
						sessionUpdate: "agent_message_chunk", content: { type: "text", text: "NOT_AN_ACK" } } });
					return { stopReason: "end_turn" };
				}
				options.handlers.onUpdate({ sessionId: id, update: {
					sessionUpdate: "agent_message_chunk", content: { type: "text", text: seed ? "OK" : "FINAL_ANSWER" } } });
				return { stopReason: "end_turn" };
			},
			async close() { if (!process.alive) return; process.alive = false; exit.resolve({ code: 0 }); },
		};
		connections.push(connection);
		return connection;
	}, "yolo");
	async function turn(messages = SEEDED, ids: { sessionId?: string; parentSessionId?: string } = {}) {
		const events: any[] = [];
		for await (const event of runtime.stream(model as any, { messages, tools: [] },
			{ sessionId: ids.sessionId ?? "history-seed", parentSessionId: ids.parentSessionId }).stream) {
			events.push(structuredClone(event));
		}
		const error = events.find((event) => event.type === "error");
		if (error) throw new Error(error.error.errorMessage);
		return events.find((event) => event.type === "done")?.message;
	}
	const side = (question: string, sessionId = "history-seed:side:conversation:btw:a:0") => turn([
		...SEEDED,
		{ role: "developer", content: "Ephemeral side-channel turn; tools are not available this turn.", timestamp: 9 },
		user(`<btw>\nQuestion:\n${question}\n</btw>`),
	], { sessionId, parentSessionId: "history-seed" });
	return { runtime, connections, actions, turn, side };
}

const SEED_FAILURES = [
	["tool", /requested a tool or permission/],
	["permission", /requested a tool or permission/],
	["mcp", /requested a tool or permission/],
	["not-ok", /did not acknowledge with OK/],
] as const;

for (const [action, pattern] of SEED_FAILURES) {
	test(`a ${action} attempt fails the seed turn, retires the partial session and rebuilds on retry`, async () => {
		const f = await fixture();
		try {
			f.actions.push(action);
			await assert.rejects(f.turn(), (error: unknown) =>
				pattern.test(String((error as Error).message)) &&
				/Compact OMP history/.test(String((error as Error).message)));
			assert.equal(f.connections.length, 1);
			assert.equal(f.connections[0].process.alive, false, "the unsafe partial session must be retired");
			assert.equal(f.connections[0].prompts.some(request => lastText(request).includes("FINAL_QUESTION")), false,
				"the current user request must never be dispatched to the retired partial session");
			const answer = await f.turn();
			assert.equal(f.connections.length, 2, "the retry must replay on a fresh ACP session");
			assert.match(JSON.stringify(f.connections[1].prompts), /HISTORY_PART_ONE_/);
			assert.match(lastText(f.connections[1].prompts.at(-1)), /FINAL_QUESTION/);
			assert.equal(answer.content.map((block: any) => block.text).join(""), "FINAL_ANSWER");
		} finally {
			await f.runtime.close();
		}
	});
}

test("legitimate seed steps that answer OK complete the turn", async () => {
	const f = await fixture();
	try {
		const answer = await f.turn();
		assert.equal(f.connections.length, 1);
		assert.ok(f.connections[0].prompts.length >= 2, "the history must be seeded before the final request");
		assert.match(lastText(f.connections[0].prompts[0]), /Reply only with: OK/);
		assert.match(lastText(f.connections[0].prompts.at(-1)), /FINAL_QUESTION/);
		assert.equal(answer.content.map((block: any) => block.text).join(""), "FINAL_ANSWER");
	} finally {
		await f.runtime.close();
	}
});

test("shadow seed chunks precede the final side question on one retained ACP session", async () => {
	const f = await fixture();
	try {
		const answer = await f.side("SHADOW_FINAL_QUESTION");
		assert.match(JSON.stringify(answer.content), /FINAL_ANSWER/);
		assert.equal(f.connections.length, 1, "the side turn owns one shadow connection");
		const shadow = f.connections[0];
		assert.ok(shadow.prompts.length >= 2, "the supplied side history must require hidden seeding");
		const firstTurnPrompts = [...shadow.prompts];
		const seeds = firstTurnPrompts.slice(0, -1);
		assert.ok(seeds.every(request => lastText(request).endsWith("Reply only with: OK")));
		assert.ok(seeds.every(request => !lastText(request).includes("SHADOW_FINAL_QUESTION")),
			"no hidden seed may contain the final side question");
		assert.match(JSON.stringify(seeds), /HISTORY_PART_ONE_/);
		assert.match(JSON.stringify(firstTurnPrompts.at(-1)), /HISTORY_PART_TWO_/,
			"the fitting trailing history shares the final payload with the side question");
		assert.match(lastText(firstTurnPrompts.at(-1)), /SHADOW_FINAL_QUESTION/);
		assert.equal(lastText(firstTurnPrompts.at(-1)).endsWith("Reply only with: OK"), false);
		const sessionId = firstTurnPrompts[0].sessionId;

		const next = await f.side("SHADOW_NEXT_QUESTION", "history-seed:side:conversation:btw:b:0");
		assert.match(JSON.stringify(next.content), /FINAL_ANSWER/);
		assert.equal(f.connections.length, 1, "the completed seed must leave a reusable shadow");
		assert.equal(shadow.prompts.length, firstTurnPrompts.length + 1, "the warm side turn sends only its delta");
		assert.ok(shadow.prompts.every(request => request.sessionId === sessionId),
			"all seed, final and warm requests retain the same ACP session");
		assert.match(lastText(shadow.prompts.at(-1)), /SHADOW_NEXT_QUESTION/);
	} finally {
		await f.runtime.close();
	}
});

for (const [action, pattern] of SEED_FAILURES) {
	test(`shadow: a ${action} seed attempt invalidates only the shadow and blocks the final side question`, async () => {
		const f = await fixture();
		try {
			await f.turn();
			const main = f.connections[0];
			const mainPromptCount = main.prompts.length;
			const question = `SHADOW_FAILED_${action}`;
			f.actions.push(action);
			await assert.rejects(f.side(question), (error: unknown) =>
				pattern.test(String((error as Error).message)) &&
				/Compact OMP history/.test(String((error as Error).message)));
			assert.equal(f.connections.length, 2, "the failed side turn creates exactly one shadow");
			const shadow = f.connections[1];
			assert.equal(shadow.process.alive, false, "the unsafe partial shadow must be invalidated");
			assert.ok(shadow.prompts.length > 0, "the failure must occur during a hidden seed step");
			assert.ok(shadow.prompts.every(request => lastText(request).endsWith("Reply only with: OK")));
			assert.doesNotMatch(JSON.stringify(shadow.prompts), new RegExp(question),
				"the final side question must not reach the invalid shadow");
			assert.equal(main.process.alive, true, "a shadow seed failure must not retire the main session");
			assert.equal(main.prompts.length, mainPromptCount, "a shadow seed must never replay into the main transcript");
			assert.doesNotMatch(JSON.stringify(main.prompts), new RegExp(question));
			if (action === "mcp") {
				assert.equal(shadow.toolResults.length, 1);
				assert.equal(shadow.toolResults[0].isError, true, "the seed-time tool call must be discarded, not executed");
			}

			const recovered = await f.side("SHADOW_RECOVERED", "history-seed:side:conversation:btw:b:0");
			assert.match(JSON.stringify(recovered.content), /FINAL_ANSWER/);
			assert.equal(f.connections.length, 3, "recovery must build a fresh shadow rather than reuse the partial session");
			assert.notEqual(f.connections[2].prompts[0].sessionId, shadow.prompts[0].sessionId);
			assert.match(lastText(f.connections[2].prompts.at(-1)), /SHADOW_RECOVERED/);
			assert.equal(main.prompts.length, mainPromptCount, "shadow recovery also leaves the main transcript untouched");
		} finally {
			await f.runtime.close();
		}
	});
}
