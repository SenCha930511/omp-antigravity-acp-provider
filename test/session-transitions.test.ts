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

// Existing transition tests exercise the explicit interrupt mode; queue mode
// has its own regression below.
process.env.OMP_ACP_STEER_MODE = "steer";

const model = { id: "gemini-3.8-flash", name: "Offline Flash", api: "antigravity-acp", provider: "antigravity-acp",
  contextWindow: 524288, maxTokens: 32000, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const otherModel = { ...model, id: "fixture-other", name: "Offline other" };
const user = (content: string) => ({ role: "user", content, timestamp: 1 });
const payload = (prompt: any) => JSON.stringify(prompt.prompt);
const current = (prompt: any) => prompt.prompt.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
const quotaResetReply = "Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset on Nov 12, 2026 01:02 UTC.";

async function fixture(maxIdleEntries = 2) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-transitions-"));
  const store = new AcpSessionStore(path.join(root, "sessions.json"));
  const sessions = new Map<string, any>(), connections: any[] = [], actions: string[] = [];
  const cancelState = { unsupported: false };
  const hangs: Array<{ promise: Promise<void>; resolve: () => void }> = [];
  const muted: string[] = [];
  let failResume = false, failLoad = false;
  let promptUsage: any;
  const okResponse = () => ({ stopReason: "end_turn", ...(promptUsage ? { usage: promptUsage } : {}) });
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
            const action = actions[0] === "seed-quota-reset" && payload(request).includes("Historical context chunk (seed step)")
              ? actions[0]
              : actions.shift();
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
              return okResponse();
            }
            if (action === "foreign") {
              const foreign = randomUUID();
              connection.foreignPermission = await options.handlers.onPermission({ sessionId: foreign,
                toolCall: { toolCallId: "foreign-call", title: "Foreign permission" },
                options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] });
              options.handlers.onUpdate({ sessionId: foreign, update: { sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "FOREIGN_SESSION_OUTPUT" } } });
            }
            if (action === "tools-quota") {
              const binding = [...runtime.resolvedBindings].find((b: any) => b.session.sessionId === connection.id);
              void runtime.requestPiTool(binding, { id: "quota-parked-tool", name: "read", arguments: {} }).then((result: any) => {
                connection.quotaToolResult = result;
              });
            }
            const directQuota = action && ["quota-reset", "seed-quota-reply", "tools-quota", "preamble-quota"].includes(action);
            const finalSeedQuota = action === "seed-quota-reset" && !payload(request).includes("Historical context chunk (seed step)");
            if (directQuota || finalSeedQuota) {
              const text = action === "preamble-quota" ? `Normal explanation follows\n${quotaResetReply}` : quotaResetReply;
              connection.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
              return action === "seed-quota-reset" || action === "seed-quota-reply" ? { stopReason: "end_turn" } : okResponse();
            }
            if (action === "presentation") {
              connection.emit({ sessionUpdate: "plan", entries: [{ status: "in_progress", content: "Synthetic plan" }] });
              connection.emit({ sessionUpdate: "tool_call", toolCallId: "synthetic-call", title: "Synthetic tool", status: "in_progress" });
              connection.emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "REAL_THOUGHT" } });
            }
            connection.emit({ sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `ACK:${connection.id}:${connection.prompts.length}` } });
            return okResponse();
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
  async function turn(id: string, messages: any[], options: { model?: any; systemPrompt?: string; tools?: any[]; promptCacheKey?: string; signal?: AbortSignal } = {}) {
    const lease = pool.acquire(id), events: any[] = [];
    try {
      for await (const event of lease.value.stream(options.model ?? model,
        { messages, systemPrompt: options.systemPrompt ?? "FIXTURE_RULES", tools: options.tools ?? [] },
        { sessionId: id, promptCacheKey: options.promptCacheKey, signal: options.signal }).stream) events.push(structuredClone(event));
      await tick();
      const error = events.find(e => e.type === "error");
      if (error) throw new Error(error.error.errorMessage);
      return events.find(e => e.type === "done")?.message;
    } finally { lease.release(); }
  }
  return { root, store, pool, connections, actions, turn, cancel: cancelState, hangs, muted,
    releaseHangs() { for (const hang of hangs) hang.resolve(); },
    failRestoration(resume: boolean, load: boolean) { failResume = resume; failLoad = load; },
    setPromptUsage(value: any) { promptUsage = value; },
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

test("quota exhaustion responses fail with their reset time before checkpoint persistence", async () => {
  const f = await fixture();
  try {
    f.actions.push("quota-reset");
    await assert.rejects(f.turn("quota", [user("REQ_QUOTA_RESET")]), error => {
      assert.match(String(error), /Antigravity quota exceeded for gemini-3\.8-flash/);
      assert.match(String(error), /Resets at 2026-11-12T01:02:00\.000Z/);
      return true;
    });
    const initialCheckpoint = await f.store.get("quota");
    assert.equal(initialCheckpoint?.messageCount, 0, "only the pre-prompt checkpoint may survive a quota failure");
    assert.equal(initialCheckpoint?.expectedAssistantFingerprint, undefined, "the exhausted text must not become an accepted assistant response");
    const connection = f.connections[0];
    assert.equal(connection.prompts.length, 1, "quota exhaustion must not trigger an automatic inference retry");
    assert.equal(connection.process.alive, true, "a healthy ACP process must remain available after quota exhaustion");

    await f.turn("quota", [user("REQ_QUOTA_RESET")]);
    assert.equal(f.connections.length, 1, "the next request must reuse the healthy ACP process");
    assert.equal(f.connections[0], connection);
    assert.equal(connection.prompts.length, 2, "only the explicit user retry sends another inference");
    assert.equal((await f.store.get("quota"))!.acpSessionId, connection.id);
  } finally { await f.close(); }
});

test("a quoted quota notice after ordinary text remains a normal assistant answer", async () => {
  const f = await fixture();
  try {
    f.actions.push("preamble-quota");
    const answer = await f.turn("quoted-quota", [user("REQ_QUOTED_NOTICE")]);
    assert.match(answer.content.map((block: any) => block.type === "text" ? block.text : "").join(""), /Normal explanation follows/);
    assert.ok((await f.store.get("quoted-quota"))!.expectedAssistantFingerprint);
    assert.equal(f.connections[0].process.alive, true);
  } finally { await f.close(); }
});

test("quota checkpoints clear in-flight state and restore the healthy session after runtime disposal", async () => {
  const f = await fixture();
  try {
    const request = user("REQ_QUOTA_RESTORE");
    const originalId = f.connections.length;
    f.actions.push("quota-reset");
    await assert.rejects(f.turn("quota-restore", [request]), /Antigravity quota exceeded/);
    const acpSessionId = (await f.store.get("quota-restore"))!.acpSessionId;
    assert.equal((await f.store.get("quota-restore"))!.ompInFlight, false);

    await f.pool.close("quota-restore");
    await f.turn("quota-restore", [request]);
    assert.equal(f.connections.length, originalId + 2, "a new runtime owns the restored connection");
    const restored = f.connections.at(-1);
    assert.equal(restored.id, acpSessionId, "quota failure must not force a new ACP session after runtime disposal");
    assert.deepEqual(restored.restored, [{ method: "resume", id: acpSessionId }]);
    assert.equal(restored.prompts.length, 1, "restoration sends only the explicit retry");
  } finally { await f.close(); }
});

test("quota with a parked tool settles cancellation and never preserves the unsafe binding", async () => {
  const f = await fixture();
  try {
    f.actions.push("tools-quota");
    await assert.rejects(f.turn("tools-quota", [user("REQ_TOOL_QUOTA")]), /Antigravity quota exceeded/);
    await tick();
    const connection = f.connections[0];
    assert.equal(connection.quotaToolResult?.isError, true, "the parked OMP tool must settle instead of timing out");
    assert.match(connection.quotaToolResult.content[0].text, /before .*tool result/);
    assert.equal(connection.process.alive, false, "pending work cannot remain attached to a new prompt boundary");
    assert.equal(await f.store.get("tools-quota"), undefined);
  } finally { await f.close(); }
});

test("ACP plan and tool status stay out of the thinking stream", async () => {
  const f = await fixture();
  try {
    f.actions.push("presentation");
    const message = await f.turn("presentation", [user("REQ_PRESENTATION")]);
    assert.ok(message);
    const thinking = message.content.filter((block: any) => block.type === "thinking").map((block: any) => block.thinking).join("");
    assert.equal(thinking, "REAL_THOUGHT");
    assert.doesNotMatch(thinking, /Antigravity (plan|tool)/);
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

test("a failed warm model change retires its checkpoint and rebuilds on retry", async () => {
  const f = await fixture();
  try {
    const first = user("REQ_MODEL_CHANGE_FIRST");
    const answer = await f.turn("model", [first]);
    const originalId = (await f.store.get("model"))!.acpSessionId;
    const warm = f.connections[0];
    warm.setModel = async () => { throw new Error("synthetic split model/effort failure"); };
    await assert.rejects(
      f.turn("model", [first, answer, user("REQ_MODEL_CHANGE_FAIL")], { model: otherModel }),
      /synthetic split model\/effort failure/,
    );
    assert.equal(warm.process.alive, false, "failed selection must close the possibly mutated session");
    assert.equal(await f.store.get("model"), undefined, "failed selection must not retain a resumable checkpoint");

    await f.turn("model", [first, answer, user("REQ_MODEL_CHANGE_RETRY")], { model: otherModel });
    const rebuilt = f.connections.at(-1);
    assert.notEqual(rebuilt, warm);
    assert.notEqual(rebuilt.id, originalId);
    assert.equal(rebuilt.prompts.at(-1).model, otherModel.id);
    assert.equal((await f.store.get("model"))!.acpSessionId, rebuilt.id);
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

test("a tool-set change at a steer boundary keeps the warm session", { timeout: 8000 }, async () => {
  const f = await fixture();
  try {
    f.cancel.unsupported = true;
    f.actions.push("tools-cap");
    const first = user("REQ_TOOLSET_STEER_FIRST");
    const askTool = { name: "ask", description: "", parameters: { type: "object", properties: {} } };
    const partial = await f.turn("toolset-steer", [first], { tools: [askTool] });
    assert.equal(partial.stopReason, "toolUse");
    const toolCall = partial.content.find((block: any) => block.type === "toolCall");
    const result = { role: "toolResult", toolName: "read", toolCallId: toolCall.id,
      content: [{ type: "text", text: "TOOL_RESULT_BODY" }], timestamp: 2 };
    const answer = await f.turn("toolset-steer", [first, partial, result, user("REQ_TOOLSET_STEER_NOW")], { tools: [] });
    assert.equal(answer.stopReason, "stop");
    assert.equal(f.connections.length, 1, "a tool-set change must not force a cold reconstruction");
    assert.match(current(f.connections[0].prompts.at(-1)), /REQ_TOOLSET_STEER_NOW/);
  } finally { await f.close(); }
});

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

test("queue mode waits for the active streaming turn and reuses it", { timeout: 8000 }, async () => {
  const previousMode = process.env.OMP_ACP_STEER_MODE;
  process.env.OMP_ACP_STEER_MODE = "queue";
  const f = await fixture();
  try {
    f.actions.push("hang");
    const first = user("REQ_QUEUE_FIRST");
    const controller = new AbortController();
    let oldFailed = false;
    const oldTurn = f.turn("queue", [first], { signal: controller.signal }).catch(() => { oldFailed = true; });
    while (!f.connections.length || f.connections[0].prompts.length < 1) await tick();
    const connection = f.connections[0], id = connection.id;
    const nextTurn = f.turn("queue", [first, user("REQ_QUEUE_NOW")]);
    await tick();
    assert.equal(connection.prompts.length, 1, "the queued request must not dispatch concurrently");
    controller.abort();
    await tick();
    assert.equal(connection.prompts.length, 1, "the old turn must not be replaced");
    f.releaseHangs();
    await nextTurn;
    await oldTurn;
    assert.equal(oldFailed, false, "queue mode must not abort the old writer");
    const request = connection.prompts.at(-1);
    assert.equal(request.sessionId, id);
    assert.match(current(request), /REQ_QUEUE_NOW/);
    assert.doesNotMatch(payload(request), /REQ_QUEUE_FIRST/);
    assert.equal(f.connections.length, 1);
  } finally {
    if (previousMode === undefined) delete process.env.OMP_ACP_STEER_MODE;
    else process.env.OMP_ACP_STEER_MODE = previousMode;
    await f.close();
  }
});

test("mid-session tool changes and volatile system-reminder/tool-name updates keep the warm session", async () => {
  const f = await fixture();
  try {
    const readTool = { name: "read", description: "Read", parameters: { type: "object", properties: {} } };
    const writeTool = { name: "write", description: "Write", parameters: { type: "object", properties: {} } };
    const first = user("REQ_TOOLS_FIRST");
    const answer = await f.turn("warm-tools", [first], {
      systemPrompt: "CORE_POLICY\n\nOMP tool names: pi_read",
      tools: [readTool],
    });
    const sessionId = (await f.store.get("warm-tools"))!.acpSessionId;
    await f.turn("warm-tools", [first, answer, user("REQ_TOOLS_SECOND")], {
      systemPrompt: "CORE_POLICY\n\n<system-reminder>\nToday: 2026-11-08\n</system-reminder>\n\nOMP tool names: pi_read, pi_write",
      tools: [readTool, writeTool],
    });
    assert.equal(f.connections.length, 1, "tool and reminder updates must not tear down the warm session");
    assert.equal((await f.store.get("warm-tools"))!.acpSessionId, sessionId);
    assert.equal(f.connections[0].prompts.length, 2);
    assert.match(current(f.connections[0].prompts[1]), /REQ_TOOLS_SECOND/);
    assert.doesNotMatch(payload(f.connections[0].prompts[1]), /REQ_TOOLS_FIRST/);
  } finally { await f.close(); }
});

test("retry after an isolated toolsAdded/toolsRemoved system delta reuses the fingerprint-gated warm binding", async () => {
  const f = await fixture();
  try {
    const readTool = { name: "read", description: "Read", parameters: { type: "object", properties: {} } };
    const writeTool = { name: "write", description: "Write", parameters: { type: "object", properties: {} } };
    const first = user("REQ_RETRY_WITH_TOOL_DELTA");
    await f.turn("retry-tool-delta", [
      { role: "system", content: "CORE_POLICY", toolsAdded: [readTool] }, first,
    ], { tools: [readTool] });
    const connection = f.connections[0];
    await f.turn("retry-tool-delta", [
      { role: "system", content: "CORE_POLICY", toolsAdded: [writeTool], toolsRemoved: ["read"] }, first,
    ], { tools: [writeTool] });
    assert.equal(f.connections.length, 1, "the isolated metadata delta must be reconciled before retry detection");
    assert.equal(connection.prompts.length, 2);
    assert.equal((await f.store.get("retry-tool-delta"))!.acpSessionId, connection.id);
    assert.match(current(connection.prompts[1]), /OMP retry request/);
    assert.match(current(connection.prompts[1]), /REQ_RETRY_WITH_TOOL_DELTA/);
  } finally { await f.close(); }
});

test("assistant boundary tolerates stripped thinking blocks and host metadata normalization", async () => {
  const f = await fixture();
  try {
    const first = user("REQ_BOUNDARY_FIRST");
    const answer = await f.turn("boundary", [first]);
    const sessionId = (await f.store.get("boundary"))!.acpSessionId;
    const normalizedAnswer = {
      role: "assistant",
      provider: "",
      model: "custom-alias",
      content: [
        { type: "thinking", thinking: "HOST_ADDED_OR_STRIPPED_THOUGHT" },
        { type: "text", text: "" },
        ...answer.content.map((b: any) => ({ ...b, extraHostField: 123 })),
      ],
    };
    await f.turn("boundary", [first, normalizedAnswer, user("REQ_BOUNDARY_NEXT")], { model: otherModel });
    assert.equal(f.connections.length, 1, "normalized assistant message must still match the warm boundary even when setModel updates binding.modelId");
    assert.equal((await f.store.get("boundary"))!.acpSessionId, sessionId);
    assert.equal(f.connections[0].prompts.length, 2);
    assert.doesNotMatch(payload(f.connections[0].prompts[1]), /REQ_BOUNDARY_FIRST|ACK:/, "normalized assistant message must be skipped as already seen");
  } finally { await f.close(); }
});

test("large multi-message cold replay seeds history in sequential steps before the current user request", async () => {
  const f = await fixture();
  try {
    const messages = [
      user("SEED_PART_1_" + "a".repeat(75_000)),
      { role: "assistant", content: [{ type: "text", text: "SEED_PART_2_" + "b".repeat(75_000) }] },
      user("SEED_PART_3_" + "c".repeat(75_000)),
      { role: "assistant", content: [{ type: "text", text: "SEED_PART_4_" + "d".repeat(75_000) }] },
      user("FINAL_SEEDED_QUESTION"),
    ];
    const answer = await f.turn("seeded", messages);
    assert.equal(f.connections.length, 1);
    assert.ok(f.connections[0].prompts.length >= 2, "expected at least one seed prompt before the final prompt");
    const finalPrompt = f.connections[0].prompts.at(-1);
    assert.match(current(finalPrompt), /FINAL_SEEDED_QUESTION/);
    // Seed step responses must not leak into the final assistant message content
    const finalText = answer.content.map((b: any) => b.text).join("");
    assert.equal(finalText, `ACK:${f.connections[0].id}:${f.connections[0].prompts.length}`);
  } finally { await f.close(); }
});

test("single oversized current message is sent as hidden seed steps before the final request", async () => {
  const f = await fixture();
  try {
    const text = "SINGLE_REQUEST_START_" + "x".repeat(220_000) + "_SINGLE_REQUEST_END";
    const answer = await f.turn("single-seeded", [user(text)]);
    const prompts = f.connections[0].prompts;
    assert.ok(prompts.length >= 2, "expected at least one seed prompt before the final prompt");
    assert.match(current(prompts[0]), /Current OMP user request \(part; not yet actionable\)/);
    assert.match(current(prompts[0]), /Reply only with: OK/);
    const finalPrompt = prompts.at(-1);
    assert.match(current(finalPrompt), /Current OMP user request \(final part\)/);
    assert.match(current(finalPrompt), /_SINGLE_REQUEST_END/);
    assert.equal(answer.content.map((b: any) => b.text).join(""),
      `ACK:${f.connections[0].id}:${prompts.length}`);
  } finally { await f.close(); }
});

test("multi-step seed usage is included in the final assistant usage", async () => {
  const f = await fixture();
  try {
    f.setPromptUsage({ inputTokens: 10, outputTokens: 2, thoughtTokens: 1 });
    const messages = [
      user("USAGE_SEED_1_" + "a".repeat(75_000)),
      { role: "assistant", content: [{ type: "text", text: "USAGE_SEED_2_" + "b".repeat(75_000) }] },
      user("USAGE_SEED_3_" + "c".repeat(75_000)),
      { role: "assistant", content: [{ type: "text", text: "USAGE_SEED_4_" + "d".repeat(75_000) }] },
      user("FINAL_USAGE_QUESTION"),
    ];
    const answer = await f.turn("seed-usage", messages);
    const prompts = f.connections[0].prompts.length;
    assert.ok(prompts >= 2, "expected seed steps before the final prompt");
    assert.equal(answer.usage.input, 10 * prompts);
    assert.equal(answer.usage.output, 2 * prompts);
    assert.equal(answer.usage.reasoning, prompts);
    assert.equal(answer.usage.totalTokens, 12 * prompts);
  } finally { await f.close(); }
});

test("quota during a hidden seed stops replay immediately and leaves a retryable checkpoint", async () => {
  const f = await fixture();
  try {
    f.actions.push("seed-quota-reply");
    const messages = [
      user("EARLY_QUOTA_1_" + "a".repeat(75_000)),
      { role: "assistant", content: [{ type: "text", text: "EARLY_QUOTA_2_" + "b".repeat(75_000) }] },
      user("EARLY_QUOTA_3_" + "c".repeat(75_000)),
    ];
    await assert.rejects(f.turn("early-seed-quota", messages), /2026-11-12T01:02:00\.000Z/);
    assert.equal(f.connections[0].prompts.length, 1, "no later seed or current request may be sent after quota exhaustion");
    assert.equal(f.connections[0].process.alive, true);
    const checkpoint = await f.store.get("early-seed-quota");
    assert.equal(checkpoint?.ompInFlight, false);
    assert.equal(checkpoint?.expectedAssistantFingerprint, undefined);

    await f.turn("early-seed-quota", messages);
    assert.ok(f.connections[0].prompts.length >= 3, "the explicit retry can replay independent seed steps before its final prompt");
  } finally { await f.close(); }
});

test("seed-step usage cannot hide a final quota notice that has no response usage", async () => {
  const f = await fixture();
  try {
    f.setPromptUsage({ inputTokens: 10, outputTokens: 2, thoughtTokens: 1 });
    f.actions.push("seed-quota-reset");
    const messages = [
      user("QUOTA_SEED_1_" + "a".repeat(75_000)),
      { role: "assistant", content: [{ type: "text", text: "QUOTA_SEED_2_" + "b".repeat(75_000) }] },
      user("QUOTA_SEED_3_" + "c".repeat(75_000)),
      { role: "assistant", content: [{ type: "text", text: "QUOTA_SEED_4_" + "d".repeat(75_000) }] },
      user("FINAL_QUOTA_QUESTION"),
    ];
    await assert.rejects(f.turn("seed-quota", messages), error => {
      assert.match(String(error), /Antigravity quota exceeded/);
      assert.match(String(error), /2026-11-12T01:02:00\.000Z/);
      return true;
    });
    assert.ok(f.connections[0].prompts.length >= 2, "the test must include usage-bearing seed steps");
    const checkpoint = await f.store.get("seed-quota");
    assert.equal(checkpoint?.messageCount, 0);
    assert.equal(checkpoint?.expectedAssistantFingerprint, undefined);
  } finally { await f.close(); }
});

test("usage already carried into the final response cannot hide quota exhaustion", async () => {
  const f = await fixture();
  try {
    f.setPromptUsage({ inputTokens: 10, outputTokens: 2, thoughtTokens: 1 });
    f.actions.push("quota-reset");
    await assert.rejects(f.turn("continuation-quota", [user("REQ_CONTINUED_QUOTA")]), /2026-11-12T01:02:00\.000Z/);
    assert.equal(f.connections[0].prompts.length, 1, "quota exhaustion remains non-retryable");
  } finally { await f.close(); }
});

test("aborting mid-way through multi-step seedSteps invalidates the partial session and forces clean cold reconstruction on resume", async () => {
  const f = await fixture();
  try {
    const messages = [
      user("ABORT_SEED_1_" + "a".repeat(75_000)),
      { role: "assistant", content: [{ type: "text", text: "ABORT_SEED_2_" + "b".repeat(75_000) }] },
      user("ABORT_SEED_3_" + "c".repeat(75_000)),
      { role: "assistant", content: [{ type: "text", text: "ABORT_SEED_4_" + "d".repeat(75_000) }] },
      user("FINAL_AFTER_SEED_ABORT"),
    ];
    f.actions.push("hang");
    const controller = new AbortController();
    const pending = f.turn("seeded-abort", messages, { signal: controller.signal });
    while (f.hangs.length === 0) await tick();
    controller.abort(new Error("user cancelled during seed step"));
    f.hangs[0]!.resolve();
    await assert.rejects(pending);
    assert.equal(await f.store.get("seeded-abort"), undefined, "aborted seed step must not persist a partial checkpoint");
    const answer = await f.turn("seeded-abort", messages);
    assert.equal(f.connections.length, 2, "next turn must reconstruct on a fresh ACP session");
    const allPrompts = JSON.stringify(f.connections[1].prompts);
    assert.match(allPrompts, /ABORT_SEED_1_/);
    assert.match(allPrompts, /FINAL_AFTER_SEED_ABORT/);
    assert.ok(answer.content.length > 0);
  } finally { await f.close(); }
});

test("steering turn with changed core system instructions forces cold reconstruction instead of reusing warm binding", async () => {
  const f = await fixture();
  try {
    f.actions.push("hang");
    const first = user("REQ_STEER_POLICY_FIRST");
    const oldTurn = f.turn("steer-policy", [first], { systemPrompt: "POLICY_OLD" }).catch(() => {});
    while (!f.connections.length || f.connections[0].prompts.length < 1) await tick();
    const oldId = f.connections[0].id;
    const nextTurn = f.turn("steer-policy", [first, user("REQ_STEER_POLICY_NEW")], { systemPrompt: "POLICY_NEW" });
    await nextTurn;
    await oldTurn;
    assert.equal(f.connections.length, 2, "changed core system instructions during steering must force cold reconstruction");
    assert.notEqual(f.connections[1].id, oldId);
    const secondPrompt = JSON.stringify(f.connections[1].prompts[0]);
    assert.match(secondPrompt, /POLICY_NEW/);
    assert.match(secondPrompt, /REQ_STEER_POLICY_FIRST/);
    assert.match(secondPrompt, /REQ_STEER_POLICY_NEW/);
  } finally { await f.close(); }
});
