// Used only by the offline OMP RPC integration. Real adapter/runtime/store,
// deterministic ACP transport, isolated state, no Google process or inference.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer as AcpMcpServer } from "@agentclientprotocol/sdk";
import { registerOmpAdapter } from "../../extension/index.ts";
import { bridgeExecutionSchema } from "../../extension/runtime/tools/bridge.ts";
import type { Tool } from "@earendil-works/pi-ai";

async function connectMcp(descriptor: AcpMcpServer) {
  if (descriptor.type !== "http" || typeof descriptor.url !== "string") return undefined;
  const headers = Object.fromEntries((descriptor.headers ?? []).map(header => [header.name, header.value]));
  const transport = new StreamableHTTPClientTransport(new URL(descriptor.url), { requestInit: { headers } });
  const client = new Client({ name: "offline-fixture", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { client, tools };
}

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
  const quotaText = process.env.OMP_ACP_SESSION_TEST_QUOTA_TEXT;
  const models = ["gemini-3.8-flash", "fixture-other"];
  const modes = ["yolo", "default", "auto_edit"];
  const createConnection = (options: any): any => {
    if (!cleanupConfigured) { options.ompCleanup.configure("balanced"); cleanupConfigured = true; }
    const exit = Promise.withResolvers<any>();
    let cleanupLease: string | undefined;
    let pending: ReturnType<typeof Promise.withResolvers<any>> | undefined;
    const mcpClients: Client[] = [];
    const mcpTools = new Map<string, Client>();
    let contextNotesCallStarted = false;
    const c: any = { process: { alive: true, pid: process.pid, exited: exit.promise, generation: ++serial }, activePrompts: 0,
      contextUsage: new Map(), usageStatus: new Map(),
      async initialize() { return { protocolVersion: 1, agentInfo: { name: "offline-fixture", version: "1.0.0" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, promptCapabilities: { embeddedContext: true, image: true }, mcpCapabilities: { http: true } } }; },
      getSessionState() { return server[c.id]; },
      async newSession(cwd: string, _signal?: AbortSignal, mcpServers: AcpMcpServer[] = []) {
        c.id = randomUUID();
        for (const descriptor of mcpServers) {
          const connection = await connectMcp(descriptor);
          if (!connection) continue;
          mcpClients.push(connection.client);
          for (const tool of connection.tools) mcpTools.set(tool.name, connection.client);
          log({ kind: "mcp-tools", id: c.id, server: descriptor.name,
            tools: connection.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
        }
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
      waitForUsageCommand() { return quotaText !== undefined; },
      async prompt(request: any, signal?: AbortSignal) {
        c.activePrompts++;
        log({ kind: "prompt", id: c.id, model: server[c.id].models.currentModelId,
          mode: server[c.id].modes.currentModeId, prompt: request.prompt });
        const currentText = request.prompt.filter((b: any) => b.type === "text").at(-1)?.text?.trim() ?? "";
        const abort = () => { void c.cancel(c.id); };
        try {
          if (quotaText !== undefined && currentText === "/usage") {
            await options.handlers.onUpdate({ sessionId: c.id, update: { sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: quotaText } } });
            return { stopReason: "end_turn" };
          }
          if (currentText === "REQ_HOLD_CANCEL") {
            pending = Promise.withResolvers<any>();
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
            return await pending.promise;
          }
          if (currentText.includes("REQ_CONTEXT_NOTES_WITNESS") && !contextNotesCallStarted) {
            contextNotesCallStarted = true;
            const client = mcpTools.get("pi_context_notes");
            if (!client) throw new Error("The actual OMP bridge did not advertise pi_context_notes");
            const calls = [
              { purpose: "supplied-intent", arguments: {
                i: "Record context rollover witness",
                text: "Context rollover witness: preserve isolated session state.",
              } },
              { purpose: "save-no-intent", arguments: {
                text: "Context rollover witness saved without intent metadata.",
              } },
              { purpose: "read-no-arguments", arguments: {} },
            ];
            for (const call of calls) {
              log({ kind: "mcp-call", id: c.id, activePrompts: c.activePrompts,
                name: "pi_context_notes", purpose: call.purpose, arguments: call.arguments });
              const result = await client.callTool({ name: "pi_context_notes", arguments: call.arguments });
              log({ kind: "mcp-result", name: "pi_context_notes", purpose: call.purpose, isError: result.isError === true,
                content: (result.content ?? []).filter(block => block.type === "text")
                  .map(block => block.text.slice(0, 4000)) });
            }
          }
          await options.handlers.onUpdate({ sessionId: c.id, update: { sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Completed offline fixture request." } } });
          return {
            stopReason: "end_turn",
            ...(process.env.OMP_ACP_SESSION_TEST_BILLING_USAGE === "1"
              ? { usage: { inputTokens: 0, cachedReadTokens: 2_888_743, outputTokens: 14_778 } }
              : {}),
          };
        } finally { signal?.removeEventListener("abort", abort); pending = undefined; c.activePrompts--; }
      },
      async cancel(id: string) { log({ kind: "cancel", id }); pending?.resolve({ stopReason: "cancelled" }); },
      async close() {
        if (!c.process.alive) return;
        c.process.alive = false;
        await Promise.allSettled(mcpClients.map(client => client.close()));
        log({ kind: "close", id: c.id });
        pending?.reject(new Error("Fixture closed")); exit.resolve({ code: 0 });
        if (cleanupLease) await options.ompCleanup.release(cleanupLease, true);
      },
    };
    return c;
  };
  for (const name of ["session_start", "agent_end", "session_switch", "session_branch", "session_tree", "session_compact", "session_shutdown"]) {
    pi.on(name, (event: any, ctx: any) => log({ kind: "event", event: name, reason: event.reason,
      ...(name === "session_compact" ? { details: event.compactionEntry?.details } : {}),
      transcriptId: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile() }));
  }
  pi.on("before_agent_start", () => ({ systemPrompt: ["FIXTURE_SYSTEM_ONE", "FIXTURE_SYSTEM_TWO"] }));
  pi.registerCommand("fixture-one-shot", { description: "Offline one-shot lifecycle probe",
    handler: async (_args: string, ctx: any) => {
      // Two one-shot side turns prove the second question reuses the first
      // turn's parent-owned shadow instead of rebuilding from history.
      const first = await ctx.runEphemeralTurn({ promptText: "REQ_ONE_SHOT_RELEASE", tools: false });
      log({ kind: "one-shot-complete", text: first.replyText });
      const second = await ctx.runEphemeralTurn({ promptText: "REQ_ONE_SHOT_SECOND", tools: false });
      log({ kind: "one-shot-complete", text: second.replyText });
    } });
  await registerOmpAdapter(new Proxy(pi, { get(target, name) {
    if (name === "registerProvider") return (id: string, provider: any) => {
      const original = provider.streamSimple;
      provider.streamSimple = (model: any, context: any, options: any) => {
        log({ kind: "stream", model: model.id, sessionId: options?.sessionId, parentSessionId: options?.parentSessionId,
          promptCacheKey: options?.promptCacheKey, systemPrompt: context.systemPrompt, cwd: process.cwd(), messages: context.messages,
          tools: (context.tools ?? [])
            .filter((tool: { name: string }) => tool.name === "context_notes" || tool.name === "new_context")
            .map((tool: { name: string; description: string; parameters: Tool["parameters"] }) => ({
              name: tool.name, description: tool.description, parameters: tool.parameters,
              executionSchema: bridgeExecutionSchema(tool),
            })) });
        const autoTrigger = JSON.stringify(context.messages.at(-1)?.content).includes("REQ_AUTO_COMPACT");
        return (async function*() {
          for await (const event of original(model, context, options)) {
            if (event.type === "toolcall_end" && (event.toolCall.name === "context_notes" || event.toolCall.name === "new_context")) {
              log({ kind: "tool-call", toolCall: event.toolCall });
            }
            if (autoTrigger && !autoCompactionTriggered && event.type === "done") {
              autoCompactionTriggered = true;
              event.message.usage.contextTokens = 50000;
              log({ kind: "synthetic-auto-compaction-trigger", used: 50000 });
            }
            if (event.type === "done") log({ kind: "done-usage", usage: event.message.usage });
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
