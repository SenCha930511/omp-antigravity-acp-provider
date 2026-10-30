// Used only by the offline OMP RPC integration. Real adapter/runtime/store,
// deterministic ACP transport, isolated state, no Google process or inference.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { registerOmpAdapter } from "../../extension/index.ts";

export default async function(pi: any) {
  const state = process.env.OMP_ACP_SESSION_TEST_STATE;
  if (!state) throw new Error("Missing isolated session-test state");
  const log = (entry: object) => fs.appendFileSync(path.join(state, "trace.jsonl"), JSON.stringify(entry) + "\n");
  const serverFile = path.join(state, "fake-server.json");
  let server: Record<string, any> = {};
  try { server = JSON.parse(fs.readFileSync(serverFile, "utf8")); } catch {}
  const persist = () => fs.writeFileSync(serverFile, JSON.stringify(server));
  let serial = 0;
  let autoCompactionTriggered = false;
  let cleanupConfigured = false;
  const models = ["gemini-3.8-flash", "fixture-other"];
  const modes = ["yolo", "default", "auto_edit"];
  const createConnection = (options: any): any => {
    if (!cleanupConfigured) { options.ompCleanup.configure("balanced"); cleanupConfigured = true; }
    const exit = Promise.withResolvers<any>();
    let cleanupLease: string | undefined;
    let pending: ReturnType<typeof Promise.withResolvers<any>> | undefined;
    const c: any = { process: { alive: true, pid: process.pid, exited: exit.promise, generation: ++serial }, activePrompts: 0,
      contextUsage: new Map(), usageStatus: new Map(),
      async initialize() { return { protocolVersion: 1, agentInfo: { name: "offline-fixture", version: "1.0.0" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, promptCapabilities: { embeddedContext: true, image: true } } }; },
      getSessionState() { return server[c.id]; },
      async newSession(cwd: string) {
        c.id = randomUUID();
        const conversations = path.join(process.env.GEMINI_HOME!, "antigravity-acp/conversations");
        fs.mkdirSync(conversations, { recursive: true });
        fs.writeFileSync(path.join(conversations, c.id + ".db"), "offline session history");
        cleanupLease = await options.ompCleanup.acquire(c.id, true, process.pid);
        server[c.id] = { modes: { currentModeId: "yolo", availableModes: modes.map(id => ({ id, name: id })) },
          models: { currentModelId: models[0], availableModels: models.map(modelId => ({ modelId, name: modelId })) } };
        persist(); log({ kind: "new", id: c.id, cwd });
        return { sessionId: c.id, ...server[c.id] };
      },
      async resumeSession(id: string) {
        if (!server[id]) throw new Error("Unknown fixture session");
        cleanupLease = await options.ompCleanup.acquire(id, false, process.pid);
        c.id = id; log({ kind: "resume", id }); return server[id];
      },
      async loadSession(id: string) { return c.resumeSession(id); },
      async setMode(id: string, mode: string) { server[id].modes.currentModeId = mode; persist(); log({ kind: "mode", id, mode }); },
      async setModel(id: string, model: string) { server[id].models.currentModelId = model; persist(); log({ kind: "model", id, model }); },
      holdPromptWatchdog() { return () => {}; },
      configureUsage() {},
      async prompt(request: any, signal?: AbortSignal) {
        c.activePrompts++;
        log({ kind: "prompt", id: c.id, model: server[c.id].models.currentModelId,
          mode: server[c.id].modes.currentModeId, prompt: request.prompt });
        const text = request.prompt.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        const abort = () => { void c.cancel(c.id); };
        try {
          if (text.includes("REQ_HOLD")) {
            pending = Promise.withResolvers<any>();
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
            return await pending.promise;
          }
          await options.handlers.onUpdate({ sessionId: c.id, update: { sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Completed offline fixture request." } } });
          return { stopReason: "end_turn" };
        } finally { signal?.removeEventListener("abort", abort); pending = undefined; c.activePrompts--; }
      },
      async cancel(id: string) { log({ kind: "cancel", id }); pending?.resolve({ stopReason: "cancelled" }); },
      async close() {
        if (!c.process.alive) return;
        c.process.alive = false;
        log({ kind: "close", id: c.id });
        pending?.reject(new Error("Fixture closed")); exit.resolve({ code: 0 });
        if (cleanupLease) await options.ompCleanup.release(cleanupLease, true);
      },
    };
    return c;
  };
  for (const name of ["session_start", "session_switch", "session_branch", "session_tree", "session_compact", "session_shutdown"]) {
    pi.on(name, (event: any, ctx: any) => log({ kind: "event", event: name, reason: event.reason,
      transcriptId: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile() }));
  }
  pi.on("before_agent_start", () => ({ systemPrompt: ["FIXTURE_SYSTEM_ONE", "FIXTURE_SYSTEM_TWO"] }));
  pi.registerCommand("fixture-one-shot", { description: "Offline one-shot lifecycle probe",
    handler: async (_args: string, ctx: any) => {
      const result = await ctx.runEphemeralTurn({ promptText: "REQ_ONE_SHOT_RELEASE", tools: false });
      log({ kind: "one-shot-complete", text: result.replyText });
    } });
  await registerOmpAdapter(new Proxy(pi, { get(target, name) {
    if (name === "registerProvider") return (id: string, provider: any) => {
      const original = provider.streamSimple;
      provider.streamSimple = (model: any, context: any, options: any) => {
        log({ kind: "stream", model: model.id, sessionId: options?.sessionId, parentSessionId: options?.parentSessionId,
          promptCacheKey: options?.promptCacheKey, systemPrompt: context.systemPrompt, cwd: process.cwd(), messages: context.messages });
        const autoTrigger = JSON.stringify(context.messages.at(-1)?.content).includes("REQ_AUTO_COMPACT");
        return (async function*() {
          for await (const event of original(model, context, options)) {
            if (autoTrigger && !autoCompactionTriggered && event.type === "done") {
              autoCompactionTriggered = true;
              event.message.usage.contextTokens = 50000;
              log({ kind: "synthetic-auto-compaction-trigger", used: 50000 });
            }
            yield event;
          }
        })();
      };
      return target.registerProvider(id, provider);
    };
    const value = Reflect.get(target, name);
    return typeof value === "function" ? value.bind(target) : value;
  } }), state, createConnection);
}
