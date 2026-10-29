import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import { AntigravityRuntime, PERMISSION_RESULT_KIND, PERMISSION_TOOL_NAME } from "../extension/runtime.mjs";

const model = { id: "gemini-3.8-flash", name: "Flash", api: "antigravity-acp", provider: "antigravity-acp",
  contextWindow: 524288, maxTokens: 32000, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const modes = { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] };
const models = { currentModelId: model.id, availableModels: [{ modelId: model.id, name: "Flash" }] };
const user = (content: string) => ({ role: "user", content, timestamp: 1 });
type Action = "plain" | "tools" | "permission" | "fail" | "empty";

function fixture() {
  const saved = new Map<string, any>(), connections: any[] = [], runtimes: any[] = [], actions: Action[] = [];
  const keepAlive = setTimeout(() => {}, 10_000);
  let failSave: "none" | "before" | "terminal" = "none", failRemove = false;
  let checkpointGate: { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | undefined;
  let retirementGate: { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | undefined;
  const store = {
    async get(id: string) { return structuredClone(saved.get(id)); },
    async save(record: any) {
      if (failSave === "before" || (failSave === "terminal" && !record.ompInFlight && record.messageCount > 1)) {
        throw new Error("synthetic checkpoint failure");
      }
      saved.set(record.piSessionId, structuredClone(record));
      if (record.ompInFlight && checkpointGate) {
        const gate = checkpointGate; gate.entered.resolve(); await gate.release.promise;
        if (checkpointGate === gate) checkpointGate = undefined;
      }
    },
    async remove(id: string) { if (failRemove) throw new Error("synthetic read-only store"); saved.delete(id); },
    async removeIfMatches(id: string, acpId: string) {
      if (saved.get(id)?.acpSessionId !== acpId) return false;
      await this.remove(id); return true;
    },
  };
  function create() {
    let runtime: any;
    runtime = new AntigravityRuntime((options: any) => {
      const exit = Promise.withResolvers<any>(), closed = Promise.withResolvers<any>();
      void closed.promise.catch(() => {});
      const c: any = { process: { alive: true, exited: exit.promise }, prompts: [], resumed: [], seenCheckpoints: [],
        async initialize() { return { protocolVersion: 1, agentCapabilities: {
          promptCapabilities: { embeddedContext: true }, sessionCapabilities: { resume: {} } } }; },
        async newSession() { c.id = randomUUID(); return { sessionId: c.id, modes, models }; },
        async resumeSession(id: string) { c.id = id; c.resumed.push(id); return { modes, models }; },
        getSessionState() { return { modes, models }; }, holdPromptWatchdog() { return () => {}; },
        async retireForReplacement() {
          if (retirementGate) {
            const gate = retirementGate; gate.entered.resolve(); await gate.release.promise;
            if (retirementGate === gate) retirementGate = undefined;
          }
        },
        async prompt(request: any) {
          c.prompts.push(structuredClone(request));
          c.seenCheckpoints.push(structuredClone(saved.get("chat")));
          const action = actions.shift() ?? "plain";
          const binding = [...runtime.resolvedBindings].find((b: any) => b.session.sessionId === c.id) as any;
          if (action === "tools") {
            await Promise.race([Promise.all(["one", "two"].map(id => runtime.requestPiTool(binding,
              { id, name: "read", arguments: {} }))), closed.promise]);
          } else if (action === "permission") {
            await Promise.race([runtime.requestPermission(binding, { sessionId: c.id,
              toolCall: { toolCallId: "permit", title: "Allow fixture" },
              options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }), closed.promise]);
          }
          if (action !== "empty") options.handlers.onUpdate({ sessionId: c.id,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ANSWER" } } });
          if (action === "fail") throw new Error("synthetic prompt failure after output");
          return { stopReason: "end_turn" };
        },
        async close() {
          if (!c.process.alive) return;
          c.process.alive = false; closed.reject(new Error("synthetic transport closed")); exit.resolve({ code: 0 });
        },
      };
      connections.push(c); return c;
    }, "yolo", store);
    runtimes.push(runtime); return runtime;
  }
  async function run(runtime: any, messages: any[]) {
    const events: any[] = [];
    for await (const event of runtime.stream(model, { messages, tools: [] }, { sessionId: "chat" }).stream) {
      events.push(structuredClone(event));
    }
    await tick(); return events;
  }
  const reply = (events: any[]) => events.find(e => e.type === "done")?.message;
  const results = (kind: "tools" | "permission", message: any) => kind === "tools"
    ? ["one", "two"].map(id => ({ role: "toolResult", toolName: "read", toolCallId: id,
        content: [{ type: "text", text: "RESULT" }], timestamp: 2 }))
    : [{ role: "toolResult", toolName: PERMISSION_TOOL_NAME, toolCallId: message.content[0].id, content: [],
        details: { kind: PERMISSION_RESULT_KIND, requestId: message.content[0].id, optionId: "allow", cancelled: false }, timestamp: 2 }];
  return { saved, connections, actions, create, run, reply, results,
    blockDispatch() { checkpointGate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }; return checkpointGate; },
    blockRetirement() { retirementGate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }; return retirementGate; },
    setFailure(save: typeof failSave, remove = false) { failSave = save; failRemove = remove; },
    async close() { checkpointGate?.release.resolve(); retirementGate?.release.resolve(); failSave = "none"; failRemove = false; clearTimeout(keepAlive); for (const r of runtimes) await r.close(); },
  };
}

test("dispatch persists an in-flight marker and completed turns clear it before warm restoration", async () => {
  const f = fixture();
  try {
    const r = f.create(), first = user("FIRST");
    const answer = f.reply(await f.run(r, [first]));
    assert.equal(f.connections[0].seenCheckpoints[0]?.ompInFlight, true);
    assert.equal(f.saved.get("chat").ompCheckpointVersion, 1);
    assert.equal(f.saved.get("chat").ompInFlight, false);
    const id = f.connections[0].id;
    await r.close();
    await f.run(f.create(), [first, answer, user("NEXT")]);
    assert.deepEqual(f.connections.at(-1).resumed, [id]);
  } finally { await f.close(); }
});

test("unknown prompt failures retire the binding and its mapping", async () => {
  const f = fixture();
  try {
    const r = f.create(), first = user("FAILED"); f.actions.push("fail");
    const events = await f.run(r, [first]);
    assert.ok(events.some(e => e.type === "error"));
    assert.equal(f.connections[0].process.alive, false);
    assert.equal(f.saved.has("chat"), false);
    await f.run(r, [first, events.find(e => e.type === "error").error, user("NEW")]);
    assert.deepEqual(f.connections.at(-1).resumed, []);
  } finally { await f.close(); }
});

test("failed terminal checkpoint plus failed removal never restores a remotely completed turn from an older boundary", async () => {
  const f = fixture();
  try {
    const r = f.create(), first = user("FIRST"), answer = f.reply(await f.run(r, [first]));
    const id = f.connections[0].id;
    f.setFailure("terminal", true);
    const failed = await f.run(r, [first, answer, user("REMOTE_COMPLETED")]);
    assert.ok(failed.some(e => e.type === "error"));
    assert.equal(f.saved.get("chat").ompInFlight, true, "The durable marker must survive failed final save/removal");
    f.setFailure("none"); await r.close();
    await f.run(f.create(), [first, answer, user("REMOTE_COMPLETED"), failed.find(e => e.type === "error").error, user("NEW")]);
    assert.deepEqual(f.connections.at(-1).resumed, []);
    assert.notEqual(f.connections.at(-1).id, id);
  } finally { await f.close(); }
});

test("failed pre-dispatch checkpoint does not send a prompt or discard a known-good conversation", async () => {
  const f = fixture();
  try {
    const r = f.create(), first = user("FIRST"), answer = f.reply(await f.run(r, [first]));
    f.setFailure("before");
    assert.ok((await f.run(r, [first, answer, user("NEXT")])).some(e => e.type === "error"));
    assert.equal(f.connections[0].prompts.length, 1);
    assert.equal(f.connections[0].process.alive, true);
    f.setFailure("none"); await f.run(r, [first, answer, user("NEXT")]);
    assert.equal(f.connections.length, 1);
    assert.equal(f.connections[0].prompts.length, 2);
  } finally { await f.close(); }
});

test("shutdown during the pre-dispatch checkpoint cannot send a late prompt", async () => {
  const f = fixture();
  try {
    const r = f.create(), gate = f.blockDispatch();
    const pending = f.run(r, [user("WAITING_FOR_CHECKPOINT")]);
    await gate.entered.promise;
    const closing = r.close(); await tick(); gate.release.resolve();
    assert.ok((await pending).some(e => e.type === "error")); await closing;
    assert.equal(f.connections[0].prompts.length, 0);
  } finally { await f.close(); }
});

test("legacy mappings without a durable dispatch marker are rebuilt once", async () => {
  const f = fixture();
  try {
    const r = f.create(), first = user("FIRST"), answer = f.reply(await f.run(r, [first]));
    delete f.saved.get("chat").ompCheckpointVersion;
    delete f.saved.get("chat").ompInFlight;
    await r.close(); await f.run(f.create(), [first, answer, user("NEXT")]);
    assert.deepEqual(f.connections.at(-1).resumed, []);
    assert.equal(f.saved.get("chat").ompCheckpointVersion, 1);
    assert.equal(f.saved.get("chat").ompInFlight, false);
  } finally { await f.close(); }
});

test("oversized local input leaves a completed warm session usable", async () => {
  const f = fixture();
  try {
    const r = f.create(), first = user("FIRST"), answer = f.reply(await f.run(r, [first]));
    const failed = await f.run(r, [first, answer, user("x".repeat(200_000))]);
    assert.match(failed.find(e => e.type === "error")?.error.errorMessage, /single-step/);
    assert.equal(f.connections[0].process.alive, true);
    assert.equal(f.connections[0].prompts.length, 1);
    assert.equal(f.saved.get("chat").ompInFlight, false);
    await f.run(r, [first, answer, user("SMALLER_REQUEST")]);
    assert.equal(f.connections.length, 1);
    assert.equal(f.connections[0].prompts.length, 2);
  } finally { await f.close(); }
});

test("a concurrent caller waits for retirement instead of restoring the old clean mapping", async () => {
  const f = fixture();
  try {
    const r = f.create(), first = user("FIRST"), answer = f.reply(await f.run(r, [first]));
    const oldId = f.connections[0].id;
    answer.content = [{ type: "text", text: "EDITED" }];
    const context = [first, answer, user("FOLLOWUP")], gate = f.blockRetirement();
    const one = f.run(r, context);
    await gate.entered.promise;
    const two = f.run(r, context);
    await tick();
    assert.equal(f.connections.length, 1, "Do not create a connection that can reload the retiring mapping");
    gate.release.resolve(); await one; await two;
    assert.ok(f.connections.slice(1).every(c => !c.resumed.includes(oldId)));
  } finally { await f.close(); }
});

for (const kind of ["tools", "permission"] as const) {
  test(`missing ${kind} results reconstruct a new session without resurrecting the old mapping`, async () => {
    const f = fixture();
    try {
      const r = f.create(), first = user("TASK"); f.actions.push(kind);
      const answer = f.reply(await f.run(r, [first])), oldId = f.connections[0].id;
      const partial = kind === "tools" ? f.results(kind, answer).slice(0, 1) : [];
      assert.ok(f.reply(await f.run(r, [first, answer, ...partial])));
      assert.notEqual(f.connections.at(-1).id, oldId);
      assert.deepEqual(f.connections.at(-1).resumed, []);
      assert.equal(f.saved.get("chat").acpSessionId, f.connections.at(-1).id);
      assert.equal(f.saved.get("chat").ompInFlight, false);
    } finally { await f.close(); }
  });

  test(`concurrent ${kind} continuations have one owner and terminate both streams`, { timeout: 3000 }, async () => {
    const f = fixture();
    let one: any, two: any;
    try {
      const r = f.create(), first = user("TASK"); f.actions.push(kind);
      const answer = f.reply(await f.run(r, [first]));
      const context = { messages: [first, answer, ...f.results(kind, answer)], tools: [] };
      one = r.stream(model, context, { sessionId: "chat" });
      two = r.stream(model, context, { sessionId: "chat" });
      await tick(); await tick();
      assert.equal(one.finished, true); assert.equal(two.finished, true);
      const collect = async (writer: any) => { const events = []; for await (const e of writer.stream) events.push(e); return events; };
      const events = [...await collect(one), ...await collect(two)];
      assert.equal(events.filter(e => e.type === "done").length, 1);
      assert.match(events.find(e => e.type === "error")?.error.errorMessage, /continuation.*already/i);
      assert.equal(f.connections.length, 1);
      assert.equal(f.connections[0].prompts.length, 1);
    } finally { one?.fail(new Error("fixture cleanup")); two?.fail(new Error("fixture cleanup")); await f.close(); }
  });
}

for (const changed of ["edited", "missing", "unchanged", "empty"] as const) {
  test(`completed assistant boundary: ${changed}`, async () => {
    const f = fixture();
    try {
      const r = f.create(), first = user("FIRST"); if (changed === "empty") f.actions.push("empty");
      const answer = f.reply(await f.run(r, [first]));
      if (changed === "edited") answer.content = [{ type: "text", text: "DIFFERENT" }];
      const retained = changed === "missing" ? [] : [answer];
      await f.run(r, [first, ...retained, user("FOLLOWUP")]);
      assert.equal(f.connections.length, ["edited", "missing"].includes(changed) ? 2 : 1);
    } finally { await f.close(); }
  });
}
