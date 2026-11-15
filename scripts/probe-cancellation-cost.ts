// Offline research only: instrument the built runtime in memory and substitute
// a deterministic transport. No account/model traffic or user session reads.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { types } from "node:util";
import { spawn } from "node:child_process";
import { once } from "node:events";
import syncFs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const bundle = path.resolve("extension/runtime.mjs");
let source = await fs.readFile(bundle, "utf8");
source = source.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(bundle).href));
const functions = ["messagesFingerprint", "messageFingerprint", "piToolFingerprint", "instructionFingerprint",
  "currentSystemInstructions", "buildPromptParts", "normalizeContext", "collapseSystemMessages"];
for (const name of functions) {
  const anchor = `function ${name}(`;
  assert.equal(source.split(anchor).length, 2, `Review instrumentation seam: ${name}`);
  source = source.replace(anchor, `function __raw_${name}(`);
  const memoName = name === "messageFingerprint" ? "system" : name === "piToolFingerprint" ? "tools" : undefined;
  const call = memoName ? `__prototypeMemos?.${memoName} && ${name === "messageFingerprint" ? "args[0].role === 'system'" : "true"}
    ? __prototypeMemos.${memoName}(args[0], () => __raw_${name}(...args)) : __raw_${name}(...args)` : `__raw_${name}(...args)`;
  source += `\nfunction ${name}(...args) { const t=performance.now(); try { return ${call}; }
    finally { __profile.push({name:${JSON.stringify(name)},ms:performance.now()-t}); } }\n`;
}
source += "\nconst __profile=[]; let __prototypeMemos; function __setPrototypeMemos(v){__prototypeMemos=v;} export { __profile, __setPrototypeMemos, __raw_messageFingerprint, __raw_piToolFingerprint };\n";
const { AntigravityRuntime, TierConnection, AcpSessionStore, __profile, __setPrototypeMemos,
  __raw_messageFingerprint, __raw_piToolFingerprint } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const base = Object.getPrototypeOf(TierConnection.prototype);
const state = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cancel-cost-"));
const model = { id: "gemini-3.8-flash", name: "Flash", api: "antigravity-acp-provider", provider: "antigravity-acp-provider",
  contextWindow: 524288, maxTokens: 32000, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const modes = { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] };
const models = { currentModelId: model.id, availableModels: [{ modelId: model.id, name: "Flash" }] };
const user = (content: string) => ({ role: "user", content, timestamp: 1 });
const tools = Array.from({ length: 64 }, (_, i) => ({ name: `probe_${i}`, description: "Offline synthetic tool",
  parameters: { type: "object", properties: Object.fromEntries(Array.from({ length: 30 }, (_, j) =>
    [`field_${j}`, { type: "string", description: "Synthetic field documentation" }])) }, execute: async () => ({}) }));
const history = Array.from({ length: 100 }, (_, i) => user(`${i} ` + "REFERENCE ".repeat(1000)));
const median = (values: number[]) => +values.sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(3);

// Research candidate: a bounded flat value snapshot, independent of generated
// system/tool container identity. Scan every field without JSON/sorting/hash on
// hits. No mutable container or function closure is retained in the snapshot.
const OBJECT = Symbol("object"), ARRAY = Symbol("array"), FUNCTION = Symbol("function");
function structuredMemo() {
  let tokens: any[] | undefined, digest: string | undefined;
  function visit(value: any, put: (token: any) => void, budget: { nodes: number }, seen: Set<object>) {
    if (++budget.nodes > 32768) throw new Error("budget");
    if (typeof value === "function") { put(FUNCTION); return; }
    if (value === null || typeof value !== "object") {
      if (["symbol", "bigint"].includes(typeof value)) throw new Error("unsupported");
      put(value); return;
    }
    // TypeBox metadata symbols deliberately fall back pending semantic review.
    const array = Array.isArray(value);
    if (types.isProxy(value) || seen.has(value) || Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype) ||
      Object.getOwnPropertySymbols(value).length) throw new Error("unsupported");
    seen.add(value);
    const keys = Object.keys(value);
    if (array && (keys.length !== value.length || Object.getOwnPropertyNames(value).length !== keys.length + 1)) throw new Error("array");
    put(array ? ARRAY : OBJECT); put(keys.length);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor)) throw new Error("accessor");
      put(key); visit(descriptor.value, put, budget, seen);
    }
  }
  return (value: any, compute: () => string) => {
    if (tokens) {
      let index = 0;
      try {
        visit(value, token => { if (!Object.is(token, tokens![index++])) throw new Error("changed"); }, { nodes: 0 }, new Set());
        if (index === tokens.length) return digest!;
      } catch { /* Recompute on any changed or unsupported shape. */ }
    }
    tokens = undefined; digest = undefined;
    let next: any[] | undefined = [];
    try { visit(value, token => next!.push(token), { nodes: 0 }, new Set()); } catch { next = undefined; }
    const result = compute(); tokens = next; digest = result; return result;
  };
}

// Equivalence checks on repeated, cloned containers and in-place schema edits.
{
  const memo = structuredMemo();
  const value: any = { role: "system", content: "rules", toolsAdded: tools };
  const check = () => assert.equal(memo(value, () => __raw_messageFingerprint(value)), __raw_messageFingerprint(value));
  check(); check(); value.toolsAdded = [...tools]; check();
  const field = tools[0].parameters.properties.field_0;
  const original = field.description;
  field.description = "edited"; check(); field.description = original; check();
  value.sections = { extra: "changed rules" }; check(); delete value.sections; check();
  const toolMemo = structuredMemo();
  const checkTools = () => assert.equal(toolMemo(tools, () => __raw_piToolFingerprint(tools)), __raw_piToolFingerprint(tools));
  checkTools(); field.description = "edited again"; checkTools(); field.description = original; checkTools();
}

async function runCase(toolCount: number, delayMs: number, disk: boolean, dedup: boolean, structured = false, productionCache = true) {
  __setPrototypeMemos(structured ? { system: structuredMemo(), tools: structuredMemo() } : undefined);
  const rows: any[] = [];
  for (let sample = 0; sample < 9; sample++) {
    const file = path.join(state, "sessions.json");
    const store = disk ? new AcpSessionStore(file) : undefined;
    const memory = new Map();
    const costs: number[] = [];
    const savedStore = { get: (id: string) => store ? store.get(id) : memory.get(id),
      remove: async (id: string) => { await store?.remove(id); memory.delete(id); },
      flush: () => store?.flush(),
      async save(record: any) { const t = performance.now(); if (store) await store.save(record); else memory.set(record.piSessionId, record);
        costs.push(performance.now() - t); } };
    let sends = 0, prompts = 0, ackAt = 0, nextAt = 0, abortAt = 0, startAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = Promise.withResolvers<any>(), ready = Promise.withResolvers<void>();
    const exit = Promise.withResolvers<any>();
    const sid = randomUUID();
    let sentForTurn = false;
    const c: any = { process: { alive: true, exited: exit.promise },
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { embeddedContext: true } } }),
      newSession: async () => ({ sessionId: sid, modes, models }),
      getSessionState: () => ({ modes, models }),
      withProgressWatchdog() {
        prompts++;
        if (prompts === 1) { ready.resolve(); return pending.promise; }
        nextAt = performance.now(); return Promise.resolve({ stopReason: "end_turn" });
      },
      async prompt(request: any, signal?: AbortSignal) { return base.prompt.call(c, request, signal); },
      async cancel() {
        if (dedup && sentForTurn) return;
        sentForTurn = true; sends++;
        if (!timer) timer = setTimeout(() => { ackAt = performance.now(); pending.resolve({ stopReason: "cancelled" }); }, delayMs);
      },
      async close() { c.process.alive = false; exit.resolve({ code: 0 }); },
    };
    const runtime = new AntigravityRuntime(() => c, "yolo", savedStore);
    if (!productionCache) {
      const bypass = Object.assign((_value: any, compute: () => string) => compute(), { clear() {} });
      runtime.ompSystemMemo = bypass; runtime.ompToolsMemo = bypass;
    }
    const selectedTools = tools.slice(0, toolCount), controller = new AbortController();
    const sessionId = randomUUID();
    async function consume(messages: any[], signal?: AbortSignal) {
      const events = [];
      for await (const event of runtime.stream(model, { messages, tools: selectedTools }, { sessionId, signal }).stream) events.push(event);
      return events;
    }
    try {
      const first = consume(history, controller.signal);
      await ready.promise;
      __profile.length = 0; costs.length = 0;
      abortAt = performance.now(); controller.abort();
      startAt = performance.now();
      const second = consume([...history, user("NEW_REQUEST")]);
      const [old, next] = await Promise.all([first, second]);
      assert.ok(old.some((event: any) => event.type === "error"));
      assert.ok(next.some((event: any) => event.type === "done"));
      assert.equal(prompts, 2);
      // No partial output in this fixture, so checkpoint validation can reuse.
      assert.equal([...runtime.resolvedBindings][0].session.sessionId, sid);
      const totals: any = {};
      for (const entry of __profile) {
        const item = totals[entry.name] ??= { calls: 0, ms: 0 }; item.calls++; item.ms += entry.ms;
      }
      rows.push({ sends, abortToDispatch: nextAt - abortAt, promptToDispatch: nextAt - startAt,
        serverWait: ackAt - abortAt, afterAck: nextAt - ackAt, storeMs: costs.reduce((a, b) => a + b, 0), totals });
    } finally { if (timer) clearTimeout(timer); await runtime.close(); }
  }
  const measured = rows.slice(3);
  return { toolCount, delayMs, disk, dedup, structured, productionCache, samples: measured.length,
    medians: Object.fromEntries(["sends", "abortToDispatch", "promptToDispatch", "serverWait", "afterAck", "storeMs"].map(key =>
      [key, median(measured.map(row => row[key]))])),
    functions: Object.fromEntries(functions.map(name => [name, {
      calls: median(measured.map(row => row.totals[name]?.calls ?? 0)),
      ms: median(measured.map(row => row.totals[name]?.ms ?? 0)),
    }])) };
}

try {
  const cases = process.argv.includes("--production")
    ? [[64, 0, false, false, false, false], [64, 0, false, false, false, true],
       [64, 0, true, false, false, false], [64, 0, true, false, false, true]]
    : [[0, 0, false, false, false], [64, 0, false, false, false],
    [64, 0, false, false, true], [64, 50, false, false, false], [64, 50, false, true, false],
    [64, 50, false, false, true], [64, 0, true, false, false], [64, 0, true, false, true]];
  for (const [count, delay, disk, dedup, structured, productionCache] of cases as Array<[number, number, boolean, boolean, boolean, boolean?]>) {
    console.log(JSON.stringify(await runCase(count, delay, disk, dedup, structured, productionCache)));
  }
  // Isolated contention: a separate process releases only this probe's lock.
  const file = path.join(state, "contended.json"), lock = file + ".lock";
  await fs.mkdir(lock);
  const unlocker = spawn("node", ["--input-type=module", "-e",
    'import fs from "node:fs"; setTimeout(() => fs.rmSync(process.argv[1], { recursive: true }), 150);', lock], { stdio: "ignore" });
  const exited = once(unlocker, "exit");
  let tickAt = 0;
  const begin = performance.now();
  const timer = setTimeout(() => { tickAt = performance.now(); }, 0);
  try {
    await new AcpSessionStore(file).save({ piSessionId: "synthetic", acpSessionId: randomUUID(), acpModelId: model.id,
      cwd: state, messageCount: 0, historyFingerprint: "synthetic", lastActive: Date.now() });
    const blockedMs = performance.now() - begin;
    await exited;
    await delay(5);
    console.log(JSON.stringify({ isolatedContention: true, requestedLockHoldMs: 150,
      asyncSaveCompletionMs: +blockedMs.toFixed(3), eventLoopTickDelayMs: +(tickAt - begin).toFixed(3) }));
  } finally { clearTimeout(timer); if (syncFs.existsSync(lock)) await fs.rm(lock, { recursive: true, force: true }); }
} finally { await fs.rm(state, { recursive: true, force: true }); }
