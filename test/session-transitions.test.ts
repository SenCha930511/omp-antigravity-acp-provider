import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import { AcpSessionStore, AntigravityRuntime } from "../extension/runtime.mjs";
import { SessionRuntimePool } from "../extension/runtime-pool.ts";
import { selectRuntimeModel } from "../extension/model-catalog.ts";

const model = { id: "gemini-3.8-flash", name: "Offline Flash", api: "antigravity-acp", provider: "antigravity-acp",
  contextWindow: 524288, maxTokens: 32000, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const otherModel = { ...model, id: "fixture-other", name: "Offline other" };
const user = (content: string) => ({ role: "user", content, timestamp: 1 });
const payload = (prompt: any) => JSON.stringify(prompt.prompt);
const current = (prompt: any) => prompt.prompt.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");

async function fixture(maxIdleEntries = 2) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-transitions-"));
  const store = new AcpSessionStore(path.join(root, "sessions.json"));
  const sessions = new Map<string, any>(), connections: any[] = [], actions: string[] = [];
  const cancelState = { unsupported: false };
  const hangs: Array<{ promise: Promise<void>; resolve: () => void }> = [];
  const muted: string[] = [];
  let failResume = false, failLoad = false;
  const pool = new SessionRuntimePool<any>(() => {
    let runtime: any;
    runtime = new AntigravityRuntime((options: any) => {
      const exit = Promise.withResolvers<any>(), closed = Promise.withResolvers<never>();
      void closed.promise.catch(() => {});
      const connection: any = { process: { alive: true, exited: exit.promise }, cwd: options.cwd, prompts: [], restored: [], activePrompts: 0,
        frozen: new Set<string>(), steerListeners: [] as Array<[string, () => void]>,
        // Mirrors TierConnection: frozen updates count as steer activity but
        // are never forwarded, so the checkpoint fingerprint stays frozen.
        emit(update: any) {
          if (connection.frozen.has(connection.id)) {
            for (const [sid, listener] of [...connection.steerListeners]) if (sid === connection.id) listener();
            return;
          }
          options.handlers.onUpdate({ sessionId: connection.id, update });
        },
        async initialize() { return { protocolVersion: 1, agentCapabilities: {
          loadSession: true, sessionCapabilities: { resume: {} }, promptCapabilities: { embeddedContext: true, image: true } } }; },
        getSessionState() { return sessions.get(connection.id); },
        async newSession() {
          connection.id = randomUUID();
          const state = { modes: { currentModeId: "yolo", availableModes: ["yolo", "default"].map(id => ({ id, name: id })) },
            models: { currentModelId: model.id, availableModels: [model, otherModel].map(m => ({ modelId: m.id, name: m.name })) } };
          sessions.set(connection.id, state);
          return { sessionId: connection.id, ...state };
        },
        async resumeSession(id: string) {
          connection.restored.push({ method: "resume", id });
          if (failResume || !sessions.has(id)) throw new Error("Fixture resume unavailable");
          connection.id = id; return connection.getSessionState();
        },
        async loadSession(id: string) {
          connection.restored.push({ method: "load", id });
          if (failLoad || !sessions.has(id)) throw new Error("Fixture load unavailable");
          connection.id = id; return connection.getSessionState();
        },
        async setModel(_id: string, id: string) { connection.getSessionState().models.currentModelId = id; },
        async setMode(_id: string, mode: string) { connection.getSessionState().modes.currentModeId = mode; },
        holdPromptWatchdog() { return () => {}; },
        async cancel() {
          if (cancelState.unsupported) {
            const error = Object.assign(new Error("Method not found: session/cancel"), { code: -32601 });
            throw error;
          }
          throw new Error("Fixture cancel unavailable");
        },
        muteSteerChunks(id: string) { muted.push(id); connection.frozen.add(id); },
        onSteerActivity(id: string, listener: () => void) {
          const entry = [id, listener] as [string, () => void];
          connection.steerListeners.push(entry);
          return () => { const at = connection.steerListeners.indexOf(entry); if (at >= 0) connection.steerListeners.splice(at, 1); };
        },
        async prompt(request: any) {
          connection.activePrompts++;
          connection.frozen.delete(connection.id);
          connection.prompts.push({ ...structuredClone(request), model: connection.getSessionState().models.currentModelId });
          try {
            const action = actions.shift();
            if (action === "tools" || action === "tools-cap" || action === "tools-max") {
              const binding = [...runtime.resolvedBindings].find((b: any) => b.session.sessionId === connection.id);
              const result = await Promise.race([runtime.requestPiTool(binding, { id: "pending-read", name: "read", arguments: {} }), closed.promise]);
              // A drained steer cancels the parked call; a long agent loop can then
              // end its own turn by budget instead of a clean end_turn.
              if (action !== "tools" && result?.isError) return { stopReason: action === "tools-cap" ? "max_turn_requests" : "max_tokens" };
            }
            if (action === "hang" || action === "hang-dribble") {
              const hang = Promise.withResolvers<void>();
              hangs.push(hang);
              const dribble = action === "hang-dribble"
                ? setInterval(() => connection.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "DRIBBLE" } }), 25)
                : undefined;
              try {
                await Promise.race([hang.promise, closed.promise]);
              } finally {
                if (dribble) clearInterval(dribble);
              }
              return { stopReason: "end_turn" };
            }
            if (action === "foreign") {
              const foreign = randomUUID();
              connection.foreignPermission = await options.handlers.onPermission({ sessionId: foreign,
                toolCall: { toolCallId: "foreign-call", title: "Foreign permission" },
                options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] });
              options.handlers.onUpdate({ sessionId: foreign, update: { sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "FOREIGN_SESSION_OUTPUT" } } });
            }
            connection.emit({ sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `ACK:${connection.id}:${connection.prompts.length}` } });
            return { stopReason: "end_turn" };
          } finally { connection.activePrompts--; }
        },
        async close() {
          if (!connection.process.alive) return;
          connection.process.alive = false; closed.reject(new Error("Fixture closed")); exit.resolve({ code: 0 });
        },
      };
      connections.push(connection); return connection;
    }, "yolo", store);
    return runtime;
  }, runtime => runtime.close(), { timeoutMs: 0, maxIdleEntries,
    canDispose: runtime => ![...runtime.resolvedBindings].some((b: any) => b.connection.activePrompts > 0) });
  async function turn(id: string, messages: any[], options: { model?: any; systemPrompt?: string; tools?: any[]; promptCacheKey?: string } = {}) {
    const lease = pool.acquire(id), events: any[] = [];
    try {
      for await (const event of lease.value.stream(options.model ?? model,
        { messages, systemPrompt: options.systemPrompt ?? "FIXTURE_RULES", tools: options.tools ?? [] },
        { sessionId: id, promptCacheKey: options.promptCacheKey }).stream) events.push(structuredClone(event));
      await tick();
      const error = events.find(e => e.type === "error");
      if (error) throw new Error(error.error.errorMessage);
      return events.find(e => e.type === "done")?.message;
    } finally { lease.release(); }
  }
  return { root, store, pool, connections, actions, turn, cancel: cancelState, hangs, muted,
    releaseHangs() { for (const hang of hangs) hang.resolve(); },
    failRestoration(resume: boolean, load: boolean) { failResume = resume; failLoad = load; },
    async close() { await pool.closeAll(); await fs.rm(root, { recursive: true, force: true }); },
  };
}

test("A → new B → resume A keeps ACP identities separate and sends only A's new request", async () => {
  const f = await fixture();
  try {
    const first = user("REQ_A_FIRST"), answer = await f.turn("A", [first]);
    const a = (await f.store.get("A"))!.acpSessionId;
    await f.turn("B", [user("REQ_B_FIRST")]);
    assert.notEqual((await f.store.get("B"))!.acpSessionId, a);
    await f.turn("A", [first, answer, user("REQ_A_NEXT")]);
    const request = f.connections[0].prompts.at(-1);
    assert.equal(request.sessionId, a);
    assert.match(current(request), /REQ_A_NEXT/);
    assert.doesNotMatch(payload(request), /REQ_A_FIRST|REQ_B_FIRST/);
  } finally { await f.close(); }
});

test("forked transcripts may share a cache key but never an ACP session or parent checkpoint", async () => {
  const f = await fixture();
  try {
    const first = user("REQ_PARENT"), answer = await f.turn("parent", [first], { promptCacheKey: "shared-prefix" });
    const parent = (await f.store.get("parent"))!.acpSessionId;
    await f.turn("fork", [first, answer, user("REQ_FORK")], { promptCacheKey: "shared-prefix" });
    assert.notEqual((await f.store.get("fork"))!.acpSessionId, parent);
    assert.match(current(f.connections.at(-1).prompts[0]), /REQ_FORK/);
    await f.turn("parent", [first, answer, user("REQ_PARENT_NEXT")]);
    assert.equal((await f.store.get("parent"))!.acpSessionId, parent);
    assert.doesNotMatch(payload(f.connections[0].prompts.at(-1)), /REQ_PARENT"|REQ_FORK/);
  } finally { await f.close(); }
});

test("tree navigation to a shorter or same-length edited branch rebuilds without discarded messages", async () => {
  for (const rewind of [true, false]) {
    const f = await fixture();
    try {
      const first = user("REQ_ROOT"), answer = await f.turn("tree", [first]);
      const oldBranch = user("REQ_DISCARDED_BRANCH"), last = await f.turn("tree", [first, answer, oldBranch]);
      const old = (await f.store.get("tree"))!.acpSessionId;
      const history = rewind ? [first, answer, user("REQ_REWIND")] :
        [first, answer, user("REQ_DIFFERENT_BRANCH"), last, user("REQ_BRANCH_NEXT")];
      await f.turn("tree", history);
      const request = f.connections.at(-1).prompts.at(-1);
      assert.notEqual(request.sessionId, old);
      assert.doesNotMatch(payload(request), /REQ_DISCARDED_BRANCH/);
      assert.match(current(request), rewind ? /REQ_REWIND/ : /REQ_BRANCH_NEXT/);
    } finally { await f.close(); }
  }
});

test("closing or LRU eviction restores a clean ACP session without replaying accepted messages", async () => {
  for (const eviction of [false, true]) {
    const f = await fixture(1);
    try {
      const first = user("REQ_ACCEPTED"), answer = await f.turn("saved", [first]);
      const id = (await f.store.get("saved"))!.acpSessionId;
      if (eviction) await f.turn("other", [user("REQ_OTHER")]);
      else await f.pool.close("saved");
      await f.turn("saved", [first, answer, user("REQ_AFTER_RESTORE")]);
      const restored = f.connections.at(-1);
      assert.equal(restored.id, id);
      assert.deepEqual(restored.restored, [{ method: "resume", id }]);
      assert.doesNotMatch(payload(restored.prompts[0]), /REQ_ACCEPTED|REQ_OTHER/);
      assert.match(current(restored.prompts[0]), /REQ_AFTER_RESTORE/);
    } finally { await f.close(); }
  }
});

test("resume fallback loads once; failed resume and load rebuild with one new current request", async () => {
  for (const loadFails of [false, true]) {
    const f = await fixture();
    try {
      const first = user("REQ_ACCEPTED"), answer = await f.turn("restore", [first]);
      const id = (await f.store.get("restore"))!.acpSessionId;
      await f.pool.close("restore"); f.failRestoration(true, loadFails);
      await f.turn("restore", [first, answer, user("REQ_NEW")]);
      const connection = f.connections.at(-1);
      assert.deepEqual(connection.restored, [{ method: "resume", id }, { method: "load", id }]);
      assert.equal(connection.prompts.length, 1);
      assert.equal(connection.id === id, !loadFails);
      assert.equal((current(connection.prompts[0]).match(/REQ_NEW/g) ?? []).length, 1);
      if (!loadFails) assert.doesNotMatch(payload(connection.prompts[0]), /REQ_ACCEPTED/);
    } finally { await f.close(); }
  }
});

test("model changes update ACP in place and repeating the same text as a new turn still sends once", async () => {
  const f = await fixture();
  try {
    const first = user("REQ_SAME_TEXT"), answer = await f.turn("model", [first]);
    const id = (await f.store.get("model"))!.acpSessionId;
    const second = await f.turn("model", [first, answer, user("REQ_SAME_TEXT")], { model: otherModel });
    const connection = f.connections.at(-1), request = connection.prompts.at(-1);
    assert.equal(connection.id, id); assert.equal(request.model, otherModel.id);
    assert.equal(connection.prompts.length, 2);
    assert.equal((payload(request).match(/REQ_SAME_TEXT/g) ?? []).length, 1);
    await f.turn("model", [first, answer, user("REQ_SAME_TEXT"), second, user("REQ_SAME_TEXT")], { model: otherModel });
    assert.equal(connection.prompts.length, 3);
    assert.equal((payload(connection.prompts.at(-1)).match(/REQ_SAME_TEXT/g) ?? []).length, 1,
      "A distinct later turn with identical text remains a legitimate request");
  } finally { await f.close(); }
});

test("reasoning changes select the new route without replaying accepted user requests", async () => {
  const f = await fixture();
  try {
    const configured: any = { ...model, reasoning: true,
      thinkingLevelMap: { off: "fixture-off", high: "fixture-high", max: "fixture-max" } };
    const messages: any[] = [];
    for (const effort of ["off", "high", "max"]) {
      messages.push(user(`REQ_EFFORT_${effort.toUpperCase()}`));
      const answer = await f.turn("reasoning", messages, { model: selectRuntimeModel(configured, effort) });
      const request = f.connections.at(-1).prompts.at(-1);
      assert.equal(request.model, `fixture-${effort}`);
      assert.equal((current(request).match(/REQ_EFFORT_/g) ?? []).length, 1);
      messages.push(answer);
    }
  } finally { await f.close(); }
});

test("changed system instructions rebuild the conversation and cannot retain stale policy", async () => {
  const f = await fixture();
  try {
    const first = user("REQ_POLICY_FIRST"), answer = await f.turn("policy", [first], { systemPrompt: "POLICY_OLD" });
    const previous = (await f.store.get("policy"))!.acpSessionId;
    await f.turn("policy", [first, answer, user("REQ_POLICY_NEXT")], { systemPrompt: "POLICY_NEW" });
    const request = f.connections.at(-1).prompts.at(-1);
    assert.notEqual(request.sessionId, previous);
    assert.match(payload(request), /POLICY_NEW/);
    assert.doesNotMatch(payload(request), /POLICY_OLD/);
    assert.doesNotMatch(current(request), /REQ_POLICY_FIRST/);
  } finally { await f.close(); }
});

test("foreign ACP notifications and permission requests cannot write into the current conversation", async () => {
  const f = await fixture();
  try {
    f.actions.push("foreign");
    const answer = await f.turn("isolated", [user("REQ_OWN_SESSION")]);
    assert.equal(answer.stopReason, "stop");
    assert.doesNotMatch(JSON.stringify(answer.content), /FOREIGN_SESSION_OUTPUT|foreign-call/);
    assert.deepEqual(f.connections[0].foreignPermission, { outcome: { outcome: "cancelled" } });
    assert.equal(f.connections[0].prompts.length, 1);
  } finally { await f.close(); }
});

test("switching model while an ACP tool is parked cannot continue silently on the previous model", { timeout: 4000 }, async () => {
  const f = await fixture();
  try {
    f.actions.push("tools");
    const first = user("REQ_TOOL_MODEL"), partial = await f.turn("model-tools", [first]);
    assert.equal(partial.stopReason, "toolUse");
    const result = { role: "toolResult", toolName: "read", toolCallId: "pending-read",
      content: [{ type: "text", text: "READ_RESULT" }], timestamp: 2 };
    await f.turn("model-tools", [first, partial, result], { model: otherModel });
    const request = f.connections.at(-1).prompts.at(-1);
    assert.equal(request.model, otherModel.id);
    assert.equal(f.connections[0].prompts.length, 1);
  } finally { await f.close(); }
});

test("moving cwd with an unchanged routing id cannot reuse the old ACP workspace", async () => {
  const f = await fixture(), originalCwd = process.cwd();
  try {
    const first = user("REQ_BEFORE_MOVE"), answer = await f.turn("moved", [first]);
    const old = (await f.store.get("moved"))!.acpSessionId;
    process.chdir(f.root);
    await f.turn("moved", [first, answer, user("REQ_AFTER_MOVE")]);
    const connection = f.connections.at(-1);
    assert.notEqual(connection.id, old);
    assert.equal(await fs.realpath(connection.cwd), await fs.realpath(f.root));
    assert.equal(connection.prompts.length, 1);
    assert.match(current(connection.prompts[0]), /REQ_AFTER_MOVE/);
  } finally { process.chdir(originalCwd); await f.close(); }
});

test("steer with unsupported session/cancel reuses the warm ACP session after the old turn ends", { timeout: 8000 }, async () => {
  const previous = process.env.OMP_ACP_STEER_GRACE_MS;
  process.env.OMP_ACP_STEER_GRACE_MS = "5000";
  const f = await fixture();
  try {
    f.cancel.unsupported = true;
    f.actions.push("hang");
    const first = user("REQ_STEER_FIRST");
    let oldTurnFailed = false;
    const oldTurn = f.turn("steer", [first]).catch(() => { oldTurnFailed = true; });
    while (!f.connections.length || f.connections[0].prompts.length < 1) await tick();
    const connection = f.connections[0], id = connection.id;
    const nextTurn = f.turn("steer", [first, user("REQ_STEER_NOW")]);
    while (!f.muted.length) await tick();
    assert.equal(connection.prompts.length, 1, "the steer must wait for the old turn instead of dispatching concurrently");
    f.releaseHangs();
    await nextTurn;
    await oldTurn;
    assert.ok(oldTurnFailed, "the superseded turn still reports the abort to its own writer");
    const request = connection.prompts.at(-1);
    assert.equal(request.sessionId, id, "the warm ACP session must survive the steer");
    assert.match(current(request), /REQ_STEER_NOW/);
    assert.doesNotMatch(payload(request), /REQ_STEER_FIRST/, "only the unseen delta is replayed");
    assert.equal(f.connections.length, 1, "no cold reconstruction may spawn a second connection");
    assert.equal((await f.store.get("steer"))!.ompInFlight, false, "the reused mapping rests clean, not in flight");
  } finally {
    if (previous === undefined) delete process.env.OMP_ACP_STEER_GRACE_MS;
    else process.env.OMP_ACP_STEER_GRACE_MS = previous;
    await f.close();
  }
});

for (const [action, label] of [["tools-cap", "max_turn_requests"], ["tools-max", "max_tokens"]] as const) {
  test(`steer at a tool boundary stays warm when the drained turn ends with ${label}`, { timeout: 8000 }, async () => {
    const f = await fixture();
    try {
      f.cancel.unsupported = true;
      f.actions.push(action);
      const first = user("REQ_BUDGET_STEER_FIRST"), partial = await f.turn("budget-steer", [first]);
      assert.equal(partial.stopReason, "toolUse");
      const toolCall = partial.content.find((block: any) => block.type === "toolCall");
      const result = { role: "toolResult", toolName: "read", toolCallId: toolCall.id,
        content: [{ type: "text", text: "TOOL_RESULT_BODY" }], timestamp: 2 };
      // OMP injects the steering message in the same request as the tool result.
      const answer = await f.turn("budget-steer", [first, partial, result, user("REQ_BUDGET_STEER_NOW")]);
      assert.equal(answer.stopReason, "stop");
      assert.equal(f.connections.length, 1, `${label} must not force a cold reconstruction`);
      const connection = f.connections[0], request = connection.prompts.at(-1);
      assert.equal(request.sessionId, connection.id, "the warm ACP session must survive the budget stop");
      assert.match(current(request), /REQ_BUDGET_STEER_NOW/);
      assert.doesNotMatch(payload(request), /REQ_BUDGET_STEER_FIRST/, "only the unseen delta is replayed");
    } finally { await f.close(); }
  });
}

test("steer grace expiry still rebuilds cold when the old turn never ends", { timeout: 8000 }, async () => {
  const previous = process.env.OMP_ACP_STEER_GRACE_MS;
  process.env.OMP_ACP_STEER_GRACE_MS = "25";
  const f = await fixture();
  try {
    f.cancel.unsupported = true;
    f.actions.push("hang");
    const first = user("REQ_STEER_EXPIRE_FIRST");
    const oldTurn = f.turn("expire", [first]).catch(() => {});
    while (!f.connections.length || f.connections[0].prompts.length < 1) await tick();
    const old = f.connections[0].id;
    const nextTurn = f.turn("expire", [first, user("REQ_STEER_EXPIRE_NOW")]);
    while (!f.muted.length) await tick();
    await nextTurn;
    await oldTurn;
    assert.equal(f.connections.length, 2, "an expired grace must fall back to reconstruction");
    assert.equal(f.connections[0].process.alive, false);
    const connection = f.connections.at(-1), request = connection.prompts.at(-1);
    assert.notEqual(connection.id, old);
    assert.match(current(request), /REQ_STEER_EXPIRE_NOW/);
    assert.match(payload(request), /REQ_STEER_EXPIRE_FIRST/, "the fallback cold-replays the retained history");
  } finally {
    if (previous === undefined) delete process.env.OMP_ACP_STEER_GRACE_MS;
    else process.env.OMP_ACP_STEER_GRACE_MS = previous;
    await f.close();
  }
});

test("steer grace extends while the old turn keeps producing output", { timeout: 8000 }, async () => {
  const previous = process.env.OMP_ACP_STEER_GRACE_MS, previousMax = process.env.OMP_ACP_STEER_GRACE_MAX_MS;
  process.env.OMP_ACP_STEER_GRACE_MS = "80";
  process.env.OMP_ACP_STEER_GRACE_MAX_MS = "10000";
  const f = await fixture();
  try {
    f.cancel.unsupported = true;
    f.actions.push("hang-dribble");
    const first = user("REQ_DRIBBLE_FIRST");
    const oldTurn = f.turn("dribble", [first]).catch(() => {});
    while (!f.connections.length || f.connections[0].prompts.length < 1) await tick();
    const connection = f.connections[0], id = connection.id;
    const nextTurn = f.turn("dribble", [first, user("REQ_DRIBBLE_NOW")]);
    while (!f.muted.length) await tick();
    setTimeout(() => f.releaseHangs(), 320);
    await nextTurn;
    await oldTurn;
    assert.equal(f.connections.length, 1, "an actively streaming turn must not expire the silence window");
    const request = connection.prompts.at(-1);
    assert.equal(request.sessionId, id, "the warm ACP session must survive the extended grace");
    assert.match(current(request), /REQ_DRIBBLE_NOW/);
    assert.doesNotMatch(payload(request), /REQ_DRIBBLE_FIRST/, "only the unseen delta is replayed");
  } finally {
    if (previous === undefined) delete process.env.OMP_ACP_STEER_GRACE_MS;
    else process.env.OMP_ACP_STEER_GRACE_MS = previous;
    if (previousMax === undefined) delete process.env.OMP_ACP_STEER_GRACE_MAX_MS;
    else process.env.OMP_ACP_STEER_GRACE_MAX_MS = previousMax;
    await f.close();
  }
});

test("steer grace still falls back cold at the absolute cap while output continues", { timeout: 8000 }, async () => {
  const previous = process.env.OMP_ACP_STEER_GRACE_MS, previousMax = process.env.OMP_ACP_STEER_GRACE_MAX_MS;
  process.env.OMP_ACP_STEER_GRACE_MS = "600000";
  process.env.OMP_ACP_STEER_GRACE_MAX_MS = "150";
  const f = await fixture();
  try {
    f.cancel.unsupported = true;
    f.actions.push("hang-dribble");
    const first = user("REQ_CAP_FIRST");
    const oldTurn = f.turn("cap", [first]).catch(() => {});
    while (!f.connections.length || f.connections[0].prompts.length < 1) await tick();
    const old = f.connections[0].id;
    const nextTurn = f.turn("cap", [first, user("REQ_CAP_NOW")]);
    while (!f.muted.length) await tick();
    await nextTurn;
    await oldTurn;
    assert.equal(f.connections.length, 2, "the absolute cap must still bound the wait");
    assert.equal(f.connections[0].process.alive, false);
    const connection = f.connections.at(-1), request = connection.prompts.at(-1);
    assert.notEqual(connection.id, old);
    assert.match(current(request), /REQ_CAP_NOW/);
  } finally {
    if (previous === undefined) delete process.env.OMP_ACP_STEER_GRACE_MS;
    else process.env.OMP_ACP_STEER_GRACE_MS = previous;
    if (previousMax === undefined) delete process.env.OMP_ACP_STEER_GRACE_MAX_MS;
    else process.env.OMP_ACP_STEER_GRACE_MAX_MS = previousMax;
    await f.close();
  }
});
