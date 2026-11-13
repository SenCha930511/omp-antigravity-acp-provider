// Deterministic BTW shadow regressions: one parent-owned ACP session per main
// owner, prefix-delta dispatch, and rebuild on every invalidating transition.
// The transport is a fake connection; no Google process, network or inference.
import { after, test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import { AcpSessionStore, AntigravityRuntime, Type } from "../extension/runtime.mjs";
import { sessionRoutingRequest } from "../extension/tool-routing.ts";
import { SessionRuntimePool } from "../extension/runtime-pool.ts";
import { ownerRoutingId, resolveSessionRoute, sessionOwnerId, sideParentRoutingId } from "../extension/runtime/routing.ts";

// Node 22 cancels a test that waits only on unref timers.
const eventLoop = new MessageChannel();
eventLoop.port1.ref();
after(() => {
  eventLoop.port1.close();
  eventLoop.port2.close();
});

const model = { id: "gemini-3.8-flash", name: "Offline Flash", api: "antigravity-acp", provider: "antigravity-acp",
  contextWindow: 524288, maxTokens: 32000, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const otherModel = { ...model, id: "fixture-other", name: "Offline other" };
const DEVELOPER = "<system-reminder>\nEphemeral side-channel turn; reuses current conversation context.\n" +
  "Tool catalog attached only to keep prompt cache warm; tools NOT available this turn.\n" +
  "Do NOT emit tool calls; reply plain text only. Tool calls discarded without execution.\n</system-reminder>";
const user = (content: string) => ({ role: "user", content, timestamp: 1 });
const assistant = (content: string) => ({ role: "assistant", content, provider: "antigravity-acp", model: model.id, timestamp: 2 });

// Mirrors the observed OMP side context: main history, a developer ephemeral
// instruction, then the `<btw>` question.
function sideContext(main: any[], question: string, developer = DEVELOPER) {
  return [
    ...main,
    { role: "developer", content: developer, timestamp: 9 },
    { role: "user", content: `<btw>\nEphemeral side question for current interactive session.\nQuestion:\n${question}\n</btw>`, timestamp: 10 },
  ];
}

const wire = (prompt: any): string => prompt.prompt
  .map((block: any) => block.type === "text" ? block.text : block.resource ? block.resource.text : "")
  .join("\n");
const payload = (prompt: any): string => JSON.stringify(prompt.prompt);

async function fixture(options: { store?: boolean; routing?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-btw-shadow-"));
  const store = options.store === false ? undefined : new AcpSessionStore(path.join(root, "sessions.json"));
  const connections: any[] = [];
  const sessions = new Map<string, any>();
  const actions: string[] = [];
  let serial = 0;
  const runtime: any = new AntigravityRuntime((connectionOptions: any) => {
    const exit = Promise.withResolvers<any>();
    void exit.promise.catch(() => undefined);
    const closed = Promise.withResolvers<never>();
    void closed.promise.catch(() => undefined);
    const initializeResponse = { protocolVersion: 1, agentInfo: { name: "antigravity-acp", version: "1.5.8" },
      agentCapabilities: {
        loadSession: true, sessionCapabilities: { resume: {}, close: {} },
        mcpCapabilities: { http: true }, _meta: { antigravity: { systemPrompt: { append: true } } },
        promptCapabilities: { embeddedContext: true, image: true } } };
    const connection: any = {
      id: undefined as string | undefined,
      prompts: [] as any[],
      sessionRequests: [] as any[],
      systemInstructions: "",
      sessionKind: undefined as string | undefined,
      newSessions: 0,
      closedSessions: [] as string[],
      discarded: [] as string[],
      process: { alive: true, pid: ++serial, exited: exit.promise, generation: serial },
      activePrompts: 0,
      async initialize() { return initializeResponse; },
      getSessionState() { return sessions.get(connection.id); },
      async setModel(_id: string, id: string) { sessions.get(connection.id).models.currentModelId = id; },
      async setMode(_id: string, mode: string) { sessions.get(connection.id).modes.currentModeId = mode; },
      holdPromptWatchdog() { return () => {}; },
      async prompt(request: any, signal?: AbortSignal) {
        connection.activePrompts++;
        connection.prompts.push(structuredClone(request));
        try {
          const action = actions.shift() ?? "answer";
          if (action === "hold") {
            const cancelled = Promise.withResolvers<any>();
            const onAbort = () => cancelled.resolve({ stopReason: "cancelled" });
            signal?.addEventListener("abort", onAbort, { once: true });
            if (signal?.aborted) onAbort();
            return await cancelled.promise;
          }
          if (action === "fail") throw new Error("synthetic shadow failure");
          connectionOptions.handlers.onUpdate({ sessionId: connection.id,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `SIDE_ANSWER:${connection.prompts.length}` } } });
          return { stopReason: "end_turn" };
        } finally { connection.activePrompts--; }
      },
      async cancel() { return undefined; },
      async closeSession(id: string) { connection.closedSessions.push(id); },
      async discardSession(id: string) { connection.discarded.push(id); },
      async retireForReplacement() { return undefined; },
      async confirmReplacement() { return undefined; },
      async close() {
        if (!connection.process.alive) return;
        connection.process.alive = false;
        closed.reject(new Error("Fixture closed"));
        exit.resolve({ code: 0 });
      },
    };
    // Mirror TierConnection's owned session methods so a routed fixture
    // exercises the real direct-_meta contract, including the binding's kind.
    const route = (request: any) => {
      if (!options.routing) return request;
      const routed = sessionRoutingRequest(request, initializeResponse, "prefer",
        connection.systemInstructions, connection.sessionKind ?? "main");
      connection.toolRouting.channel = routed === request ? "legacy-prompt" : "system-append";
      return routed;
    };
    const sdk = {
      async newSession(request: any) {
        connection.id = randomUUID();
        connection.newSessions++;
        connection.sessionRequests.push(structuredClone(request));
        sessions.set(connection.id, {
          modes: { currentModeId: "yolo", availableModes: ["yolo", "default"].map(id => ({ id, name: id })) },
          models: { currentModelId: model.id, availableModels: [model, otherModel].map(item => ({ modelId: item.id, name: item.name })) },
        });
        return { sessionId: connection.id, ...sessions.get(connection.id) };
      },
      async resumeSession(request: any) {
        if (!sessions.has(request.sessionId)) throw new Error("Fixture session unknown");
        connection.id = request.sessionId;
        return sessions.get(connection.id);
      },
      async loadSession(request: any) { return sdk.resumeSession(request); },
    };
    if (options.routing) connection.toolRouting = { nativeTools: "prefer", channel: "pending" };
    connection.newSession = async (cwd: string, _signal?: AbortSignal, mcpServers: any[] = []) => sdk.newSession(route({ cwd, mcpServers }));
    connection.resumeSession = async (id: string, cwd: string, mcpServers: any[] = []) => sdk.resumeSession(route({ sessionId: id, cwd, mcpServers }));
    connection.loadSession = async (id: string, cwd: string, mcpServers: any[] = []) => sdk.loadSession(route({ sessionId: id, cwd, mcpServers }));
    connection.setOmpSystemInstructions = (text: string) => { connection.systemInstructions = text; };
    connection.setOmpSessionKind = (kind: string) => { connection.sessionKind = kind; };
    connections.push(connection);
    return connection;
  }, "yolo", store);


  async function turn(messages: any[], streamOptions: { sessionId?: string; parentSessionId?: string; signal?: AbortSignal; model?: any; systemPrompt?: string; tools?: any[] } = {}) {
    const events: any[] = [];
    const stream = runtime.stream(streamOptions.model ?? model,
      { messages, systemPrompt: streamOptions.systemPrompt ?? "FIXTURE_RULES", tools: streamOptions.tools ?? [] },
      { sessionId: streamOptions.sessionId, parentSessionId: streamOptions.parentSessionId, signal: streamOptions.signal });
    for await (const event of stream.stream) events.push(structuredClone(event));
    await tick();
    return events;
  }
  const side = (main: any[], question: string, streamOptions: { sessionId?: string; parentSessionId?: string; signal?: AbortSignal; model?: any; systemPrompt?: string; tools?: any[] } = {}) =>
    turn(sideContext(main, question), { sessionId: "MAIN:side:conversation:btw:a:0", parentSessionId: "MAIN", ...streamOptions });
  const reply = (events: any[]) => events.find(event => event.type === "done")?.message;
  const failure = (events: any[]) => events.find(event => event.type === "error")?.error.errorMessage;
  return { root, store, connections, actions, runtime, turn, side, reply, failure,
    async close() { await runtime.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

const shadowProcesses = async (runtime: any) => (await runtime.snapshot()).processes.filter((item: any) => item.role === "shadow");

test("shadow: two BTW ids in one owner reuse one ACP session and send only the new question", async () => {
  const f = await fixture();
  try {
    const main = [user("MAIN_ASK"), assistant("MAIN_ANSWER")];
    const first = await f.side(main, "BTW_ONE");
    assert.ok(f.reply(first), "the first side question must answer");
    assert.equal(f.connections.length, 1, "the first side request owns one shadow connection");
    assert.equal(f.connections[0].newSessions, 1);
    assert.match(wire(f.connections[0].prompts[0]), /BTW_ONE/);
    assert.match(wire(f.connections[0].prompts[0]), /MAIN_ASK/, "the seed carries the supplied side context");

    const second = await f.side(main, "BTW_TWO", { sessionId: "MAIN:side:conversation:btw:b:0" });
    assert.ok(f.reply(second));
    assert.equal(f.connections.length, 1, "a new side id must not spawn another process");
    assert.equal(f.connections[0].newSessions, 1, "a warm shadow must not create a new ACP session");
    assert.equal(f.connections[0].prompts.length, 2);
    const request = f.connections[0].prompts[1];
    assert.match(wire(request), /BTW_TWO/);
    assert.doesNotMatch(payload(request), /MAIN_ASK|MAIN_ANSWER|BTW_ONE|Ephemeral side-channel turn/);
    assert.deepEqual(request.prompt.map((block: any) => block.type), ["text", "text"],
      "the warm request carries no history or instruction resource");
    assert.ok(Buffer.byteLength(payload(request), "utf8") < 400, "the warm payload is only framing plus the new question");
    assert.match(wire(request), /# Current OMP user request/);
    assert.doesNotMatch(wire(request), /# OMP retry request|# Continue the active OMP request/);

    const shadows = await shadowProcesses(f.runtime);
    assert.equal(shadows.length, 1);
    assert.equal(shadows[0].key, "shadow:MAIN");
    assert.deepEqual(shadows[0].shadow, { kind: "clean", absorbed: 3 });
  } finally { await f.close(); }
});

test("shadow: main growth sends only the main delta and the new question", async () => {
  const f = await fixture();
  try {
    const first = [user("MAIN_FIRST"), assistant("MAIN_FIRST_ANSWER")];
    await f.side(first, "BTW_ONE");
    const grown = [...first, user("MAIN_SECOND"), assistant("MAIN_SECOND_ANSWER")];
    await f.side(grown, "BTW_TWO", { sessionId: "MAIN:side:conversation:btw:b:0" });
    const request = f.connections[0].prompts[1];
    assert.equal(f.connections[0].newSessions, 1, "main growth must not rebuild the shadow");
    assert.match(payload(request), /MAIN_SECOND|MAIN_SECOND_ANSWER/, "only the unseen main delta travels");
    assert.doesNotMatch(payload(request), /MAIN_FIRST|BTW_ONE|Ephemeral side-channel turn/);
    assert.ok(Buffer.byteLength(payload(request), "utf8") < Buffer.byteLength(payload(f.connections[0].prompts[0]), "utf8"),
      "the growth delta is smaller than the seed it extends");
    assert.match(wire(request), /BTW_TWO/);
  } finally { await f.close(); }
});

test("shadow: a same-length replacement is a new request, an identical replacement is the only retry", async () => {
  const f = await fixture();
  try {
    const main = [user("MAIN_ASK"), assistant("MAIN_ANSWER")];
    await f.side(main, "BTW_SAME_LENGTH");
    await f.side(main, "BTW_REPLACED", { sessionId: "MAIN:side:conversation:btw:b:0" });
    const replaced = f.connections[0].prompts[1];
    assert.match(wire(replaced), /BTW_REPLACED/);
    assert.doesNotMatch(wire(replaced), /BTW_SAME_LENGTH|# OMP retry request/);
    assert.match(wire(replaced), /# Current OMP user request/);

    await f.side(main, "BTW_REPLACED", { sessionId: "MAIN:side:conversation:btw:c:0" });
    const retried = f.connections[0].prompts[2];
    assert.match(wire(retried), /# OMP retry request/);
    assert.match(wire(retried), /BTW_REPLACED/);
    assert.doesNotMatch(wire(retried), /# Current OMP user request/);
    assert.equal(f.connections[0].newSessions, 1, "retry framing never rebuilds a certain shadow");
  } finally { await f.close(); }
});

test("shadow: deeper rewind and shrunk history rebuild from the supplied side context", async () => {
  for (const next of [
    [user("MAIN_EDITED"), assistant("MAIN_ANSWER")],
    [user("MAIN_ASK")],
  ]) {
    const f = await fixture();
    try {
      await f.side([user("MAIN_ASK"), assistant("MAIN_ANSWER")], "BTW_ONE");
      assert.equal(f.connections.length, 1);
      await f.side(next, "BTW_TWO", { sessionId: "MAIN:side:conversation:btw:b:0" });
      assert.equal(f.connections.length, 2, "a rewound main history discards the shadow");
      const rebuilt = f.connections[1];
      assert.equal(rebuilt.newSessions, 1);
      assert.match(wire(rebuilt.prompts[0]), /BTW_TWO/);
      assert.match(wire(rebuilt.prompts[0]), /MAIN_EDITED|MAIN_ASK/);
      assert.equal(f.connections[0].process.alive, false, "the replaced shadow connection is closed");
    } finally { await f.close(); }
  }
});

test("shadow: cancellation and prompt failure rebuild before the next question", async () => {
  for (const action of ["hold", "fail"] as const) {
    const f = await fixture();
    try {
      const main = [user("MAIN_ASK"), assistant("MAIN_ANSWER")];
      await f.side(main, "BTW_ONE");
      f.actions.push(action);
      const controller = new AbortController();
      const pending = f.side(main, "BTW_BROKEN", { sessionId: "MAIN:side:conversation:btw:b:0", signal: controller.signal });
      if (action === "hold") {
        for (let i = 0; i < 200 && (f.connections[0].activePrompts === 0 || f.connections[0].prompts.length < 2); i++) await tick();
        controller.abort();
      }
      const events = await pending;
      assert.ok(f.failure(events), `${action} must surface an error`);
      assert.equal(f.connections[0].process.alive, false, `${action} must close the uncertain shadow`);
      assert.deepEqual(await shadowProcesses(f.runtime), []);

      await f.side(main, "BTW_RECOVERED", { sessionId: "MAIN:side:conversation:btw:c:0" });
      assert.equal(f.connections.length, 2, `${action} must reconstruct rather than reuse`);
      const rebuilt = f.connections[1];
      assert.equal(rebuilt.newSessions, 1);
      assert.match(wire(rebuilt.prompts[0]), /BTW_RECOVERED/);
      assert.match(wire(rebuilt.prompts[0]), /MAIN_ASK/, "reconstruction re-seeds the supplied side context");
    } finally { await f.close(); }
  }
});

test("shadow: model, mode and instruction changes each rebuild the shadow", async () => {
  for (const scenario of ["model", "mode", "instructions"] as const) {
    const f = await fixture();
    try {
      const main = [user("MAIN_ASK"), assistant("MAIN_ANSWER")];
      await f.side(main, "BTW_ONE");
      if (scenario === "model") {
        await f.side(main, "BTW_AFTER_CHANGE", { sessionId: "MAIN:side:conversation:btw:b:0", model: otherModel });
      } else if (scenario === "mode") {
        await f.runtime.setPermissionMode("default");
        assert.equal(f.connections[0].process.alive, false, "a permission-mode change discards the shadow");
        await f.runtime.setPermissionMode("yolo");
        await f.side(main, "BTW_AFTER_CHANGE", { sessionId: "MAIN:side:conversation:btw:b:0" });
      } else {
        await f.side(main, "BTW_AFTER_CHANGE", { sessionId: "MAIN:side:conversation:btw:b:0", systemPrompt: "CHANGED_RULES" });
      }
      assert.equal(f.connections.length, 2, `${scenario} must rebuild rather than reuse`);
      assert.equal(f.connections[1].newSessions, 1);
      assert.match(wire(f.connections[1].prompts[0]), /BTW_AFTER_CHANGE/);
      assert.match(wire(f.connections[1].prompts[0]), /MAIN_ASK/, "the rebuild re-seeds the side context");
    } finally { await f.close(); }
  }
});

test("shadow: a :spec: routing id stays a main route and never becomes a shadow", async () => {
  const f = await fixture();
  try {
    const main = [user("MAIN_ASK"), assistant("MAIN_ANSWER")];
    await f.side(main, "BTW_ONE");
    const spec = await f.turn([user("SPEC_REQUEST")], { sessionId: "MAIN:spec:plan", parentSessionId: "MAIN" });
    assert.ok(f.reply(spec));
    const specConnection = f.connections.at(-1);
    assert.notEqual(specConnection, f.connections[0], ":spec: does not borrow the shadow connection");
    const processes = (await f.runtime.snapshot()).processes;
    const specProcess = processes.find((item: any) => item.key === "sid:MAIN:spec:plan");
    assert.ok(specProcess, "a :spec: id keeps its own main binding key");
    assert.equal(specProcess.role, "main");
    assert.equal(specProcess.sessionId, specConnection.id);
    assert.ok(!processes.some((item: any) => item.key.startsWith("shadow:") && item.sessionId === specConnection.id));
  } finally { await f.close(); }
});

test("shadow: no store row, no main checkpoint advance and no main session pollution", async () => {
  const f = await fixture();
  try {
    const main = [user("MAIN_ASK"), assistant("MAIN_ANSWER")];
    const mainEvents = await f.turn(main, { sessionId: "MAIN" });
    assert.ok(f.reply(mainEvents));
    const saved = await f.store!.get("MAIN");
    assert.ok(saved);
    const mainConnection = f.connections[0];
    assert.equal(mainConnection.prompts.length, 1);

    await f.side(main, "BTW_ONE", { sessionId: "MAIN:side:conversation:btw:a:0" });
    await f.side(main, "BTW_TWO", { sessionId: "MAIN:side:conversation:btw:b:0" });
    const shadowConnection = f.connections[1];
    assert.equal(shadowConnection.prompts.length, 2);
    assert.equal(mainConnection.prompts.length, 1, "side turns never prompt the main ACP session");

    assert.equal(await f.store!.get("MAIN:side:conversation:btw:a:0"), undefined);
    assert.equal(await f.store!.get("MAIN:side:conversation:btw:b:0"), undefined);
    const after = await f.store!.get("MAIN");
    assert.equal(after?.acpSessionId, saved.acpSessionId);
    assert.equal(after?.messageCount, saved.messageCount, "a shadow never advances the main checkpoint");
    assert.deepEqual((await f.store!.list()).map(record => record.piSessionId), ["MAIN"]);

    const nextMain = await f.turn([...main, f.reply(mainEvents), user("MAIN_NEXT")], { sessionId: "MAIN" });
    assert.ok(f.reply(nextMain));
    assert.equal(f.connections.length, 2, "the main binding stays warm across side turns");
    assert.match(wire(mainConnection.prompts[1]), /MAIN_NEXT/);
    assert.doesNotMatch(payload(mainConnection.prompts[1]), /BTW_ONE|BTW_TWO/);
  } finally { await f.close(); }
});

test("shadow: parent close is idempotent and closes the shadow and main deterministically", async () => {
  const f = await fixture();
  try {
    const main = [user("MAIN_ASK"), assistant("MAIN_ANSWER")];
    await f.turn(main, { sessionId: "MAIN" });
    await f.side(main, "BTW_ONE");
    const [mainConnection, shadowConnection] = f.connections;
    const shadowSession = shadowConnection.id;
    await f.runtime.close();
    await f.runtime.close();
    assert.equal(mainConnection.process.alive, false);
    assert.equal(shadowConnection.process.alive, false);
    assert.deepEqual(shadowConnection.discarded, [shadowSession], "the shadow session is discarded once");
    assert.deepEqual(shadowConnection.closedSessions, [shadowSession], "session/close is used when advertised");
    assert.equal((await f.runtime.snapshot()).bindings, 0);
    assert.equal(shadowConnection.prompts.length, 1, "closing never prompts");
    assert.ok(await f.store!.get("MAIN"), "closing a runtime preserves the saved main mapping");
  } finally { await f.close(); }
});

test("shadow: idle expiry of the owner runtime disposes the shadow connection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture({ store: false });
  const pool = new SessionRuntimePool<any>(() => f.runtime, runtime => runtime.close(),
    { timeoutMs: 1000, maxIdleEntries: 2, canDispose: runtime => ![...runtime.resolvedBindings].some((binding: any) => binding.connection.activePrompts > 0) });
  try {
    const lease = pool.acquire("MAIN");
    await f.turn([user("MAIN_ASK"), assistant("MAIN_ANSWER")], { sessionId: "MAIN" });
    await f.side([user("MAIN_ASK"), assistant("MAIN_ANSWER")], "BTW_ONE");
    lease.release();
    t.mock.timers.tick(1000);
    for (let i = 0; i < 32; i++) await Promise.resolve();
    assert.equal(pool.peek("MAIN"), undefined, "idle expiry detaches the owner runtime");
    assert.equal(f.connections.length, 2);
    for (const connection of f.connections) assert.equal(connection.process.alive, false, "both bindings close with the owner");
  } finally { await f.close(); }
});

test("shadow routing: only a strict :side: marker borrows the parent runtime", () => {
  assert.equal(sideParentRoutingId("MAIN:side:conversation:btw:NONCE:0"), "MAIN");
  assert.equal(sideParentRoutingId("MAIN:spec:plan"), undefined);
  assert.equal(sideParentRoutingId("MAIN:side:"), undefined);
  assert.equal(sideParentRoutingId(":side:x"), undefined);
  assert.equal(sideParentRoutingId("A:side:B:side:C"), undefined);
  assert.equal(sideParentRoutingId(undefined), undefined);
  assert.equal(ownerRoutingId("MAIN:side:x"), "MAIN");
  assert.equal(ownerRoutingId("MAIN"), "MAIN");
  assert.deepEqual(resolveSessionRoute("MAIN:side:x"), { kind: "shadow", routingId: "MAIN:side:x", parentRoutingId: "MAIN" });
  assert.deepEqual(resolveSessionRoute("MAIN:side:x", "DECLARED"),
    { kind: "shadow", routingId: "MAIN:side:x", parentRoutingId: "DECLARED" });
  assert.deepEqual(resolveSessionRoute("MAIN:side:x", "MAIN:side:y"),
    { kind: "shadow", routingId: "MAIN:side:x", parentRoutingId: "MAIN" });
  assert.deepEqual(resolveSessionRoute("MAIN", "OTHER"), { kind: "main", routingId: "MAIN" });
  assert.equal(sessionOwnerId("MAIN:side:x", "MAIN"), "MAIN");
  assert.equal(sessionOwnerId("MAIN:side:x"), "MAIN");
  assert.equal(sessionOwnerId(undefined), undefined);

  let serial = 0;
  const pool = new SessionRuntimePool(() => ({ id: ++serial }), async () => {});
  const first = pool.acquire(sessionOwnerId("MAIN:side:a", undefined));
  first.release();
  const second = pool.acquire(sessionOwnerId("MAIN:side:b", "MAIN"));
  assert.equal(second.value, first.value, "a changed side id resolves to the parent's pool entry");
  assert.equal(serial, 1);
  second.release();
});

test("shadow routing: the side append says no tools may run while main keeps pi_task", async () => {
  const f = await fixture({ routing: true });
  try {
    const tool = { name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) };
    const main = [user("MAIN_ASK"), assistant("MAIN_ANSWER")];
    const mainEvents = await f.turn(main, { sessionId: "MAIN", tools: [tool] });
    assert.ok(f.reply(mainEvents));
    const mainConnection = f.connections[0];
    assert.equal(mainConnection.sessionKind, "main");
    const mainAppend = mainConnection.sessionRequests[0]?._meta?.antigravity?.systemPrompt?.append;
    assert.equal(typeof mainAppend, "string");
    assert.match(mainAppend, /maps to pi_task/);
    assert.doesNotMatch(mainAppend, /no tools may be called/);

    const sideEvents = await f.side(main, "BTW_ROUTED", { tools: [tool] });
    assert.ok(f.reply(sideEvents));
    const shadowConnection = f.connections[1];
    assert.equal(shadowConnection.sessionKind, "ephemeral");
    const sideAppend = shadowConnection.sessionRequests[0]?._meta?.antigravity?.systemPrompt?.append;
    assert.equal(typeof sideAppend, "string");
    assert.ok(sideAppend.startsWith("FIXTURE_RULES"), "the complete main instruction is still carried");
    assert.match(sideAppend, /no tools may be called in this side turn/);
    assert.match(sideAppend, /tool calls are discarded without execution/);
    assert.doesNotMatch(sideAppend, /maps to pi_task/);
    assert.doesNotMatch(sideAppend, /use pi_ names|pi_read|pi_write|supplied tool schema|supplied wait mechanism/);
    assert.doesNotMatch(payload(shadowConnection.prompts[0]), /FIXTURE_RULES/,
      "the append channel must not duplicate the instructions in the side prompt");
  } finally { await f.close(); }
});

test("shadow: seed, warm delta and retry prompts never authorize a discarded tool call", async () => {
  // Both wiring shapes: the legacy prompt resource path and the real
  // append-channel path that mirrors the CLI/SDK routing seam.
  for (const routing of [false, true]) {
    const f = await fixture({ routing });
    try {
      const tool = { name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) };
      const main = [user("MAIN_ASK"), assistant("MAIN_ANSWER")];
      const mainEvents = await f.turn(main, { sessionId: "MAIN", tools: [tool] });
      assert.ok(f.reply(mainEvents));
      const mainPrompt = payload(f.connections[0].prompts[0]);
      assert.match(mainPrompt, /including another pi_task/, "the main request keeps delegation");
      assert.doesNotMatch(mainPrompt, /No tools may be called in this side turn/);

      const seeded = await f.side(main, "BTW_SEED", { tools: [tool] });
      assert.ok(f.reply(seeded));
      const shadowConnection = f.connections[1];
      const seed = payload(shadowConnection.prompts[0]);
      assert.match(seed, /MAIN_ASK/, "the seed carries the main history");
      assert.match(seed, /No tools may be called in this side turn/);
      assert.match(seed, /tool calls are discarded without execution/);
      assert.doesNotMatch(seed, /including another pi_task|New tool calls|Make any new tool calls|maps to pi_task/);

      await f.side(main, "BTW_WARM", { sessionId: "MAIN:side:conversation:btw:b:0", tools: [tool] });
      const warm = payload(shadowConnection.prompts[1]);
      assert.match(warm, /BTW_WARM/);
      assert.match(warm, /No tools may be called in this side turn/);
      assert.doesNotMatch(warm, /including another pi_task|New tool calls|Make any new tool calls|maps to pi_task/);

      await f.side(main, "BTW_WARM", { sessionId: "MAIN:side:conversation:btw:c:0", tools: [tool] });
      const retried = payload(shadowConnection.prompts[2]);
      assert.match(retried, /# OMP retry request/);
      assert.match(retried, /No tools may be called in this side turn/);
      assert.doesNotMatch(retried, /including another pi_task|Make any new tool calls|maps to pi_task/);
      assert.equal(shadowConnection.newSessions, 1, "seed, delta and retry reuse one shadow session");
    } finally { await f.close(); }
  }
});
