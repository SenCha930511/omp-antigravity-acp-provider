// Explicit live smoke test. Synthetic OMP tools do not read/write real files
// or execute commands. Session restoration uses an isolated temporary mapping.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
if (!process.argv.includes("--live")) throw new Error("Pass --live explicitly; consumes quota and creates ACP sessions.");
const root = process.env.OMP_ACP_DIAGNOSTIC_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { TierConnection, AntigravityRuntime, AcpSessionStore, Type } = await import(pathToFileURL(path.join(root, "extension/runtime.mjs")).href);
const { projectCatalog, selectRuntimeModel } = await import(pathToFileURL(path.join(root, "extension/model-catalog.ts")).href);
const cache = JSON.parse(await fs.readFile(path.join(os.homedir(), ".omp/agent/antigravity-acp-provider/models-cache.json"), "utf8"));
const models = projectCatalog(cache.models);
const tools = [
  { name: "read", description: "Read the synthetic probe://fixture value. No filesystem access.", parameters: Type.Object({ path: Type.String() }) },
  { name: "edit", description: "Replace text in synthetic probe://fixture. No filesystem access.", parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }) },
  { name: "bash", description: "Run synthetic diagnostic-check, returning a test marker. No process execution.", parameters: Type.Object({ command: Type.String() }) },
];
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-routing-live-"));
let runtime: any;
let report: any;
function createRuntime(mode: string, mapping: string) {
  return new AntigravityRuntime((options: any) => {
    const handlers = options.handlers;
    const connection = new TierConnection({ ...options, ompNativeTools: mode, ompDebugToolUpdates: true, handlers: { ...handlers,
      onUpdate: async (notification: any) => {
        if (notification.update.sessionUpdate === "tool_call") report.serverTools.push(notification.update.title);
        await handlers.onUpdate?.(notification);
      },
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    } });
    const transport = connection.connection.connection;
    const send = transport.sendRequest.bind(transport);
    transport.sendRequest = (method: string, params: any, ...rest: any[]) => {
      if (["session/new", "session/load", "session/resume"].includes(method)) {
        const meta = params._meta?.antigravity;
        const append = meta?.systemPrompt?.append ?? "";
        report.sessions.push({ method, mode, systemAppend: append.includes("Diagnostic only."),
          taskMapping: append.includes("maps to pi_task"),
          eager: meta?.eagerMcpServers, enabledTools: meta?.enabledTools, disabledTools: meta?.disabledTools });
      }
      return send(method, params, ...rest);
    };
    return connection;
  }, "yolo", new AcpSessionStore(mapping));
}

async function turn(model: any, messages: any[], sessionId: string, fixture: { value: string }, expected: string) {
  for (let round = 0; round < 8; round++) {
    const writer = runtime.stream(model, { messages, tools, systemPrompt: "Diagnostic only. Use supplied OMP tools for the synthetic probe://fixture. No real file access, commands, or browsing." }, { sessionId, reasoning: "medium", signal: AbortSignal.timeout(120_000) });
    let message: any;
    for await (const event of writer.stream) {
      if (event.type === "error") throw new Error(event.error?.errorMessage ?? "Live stream failed");
      if (event.type === "done") message = structuredClone(event.message);
    }
    assert.ok(message);
    messages.push(message);
    const calls = message.content.filter((item: any) => item.type === "toolCall");
    if (!calls.length) {
      const answer = message.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("");
      assert.ok(answer.includes(expected), answer);
      return;
    }
    for (const call of calls) {
      report.ompCalls.push(call.name);
      let text = "Invalid diagnostic operation";
      let valid = false;
      if (call.name === "read" && call.arguments.path === "probe://fixture") { text = fixture.value; valid = true; }
      if (call.name === "edit" && call.arguments.path === "probe://fixture" && fixture.value.includes(call.arguments.oldText)) {
        fixture.value = fixture.value.replace(call.arguments.oldText, call.arguments.newText); text = "Edited synthetic fixture"; valid = true;
      }
      if (call.name === "bash" && call.arguments.command === "diagnostic-check") { text = "COMMAND_TOOL_OK"; valid = true; }
      messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError: !valid, timestamp: Date.now() });
    }
  }
  throw new Error("Diagnostic exceeded tool round limit");
}

try {
  for (const firstMode of ["prefer", "disabled"]) {
    report = { firstMode, restoredMode: firstMode === "prefer" ? "disabled" : "prefer", sessions: [], serverTools: [], ompCalls: [] };
    const mapping = path.join(temporary, `${firstMode}.json`);
    const sessionId = `routing-live-${firstMode}-${Date.now()}`;
    const fixture = { value: "BEFORE" };
    const messages: any[] = [{ role: "user", content: "Use the supplied tools, in order: read probe://fixture; edit it replacing BEFORE with AFTER; call bash with command diagnostic-check. Finally reply ROUTING_TURN_OK. These are synthetic tools; do not use native tools.", timestamp: Date.now() }];
    runtime = createRuntime(firstMode, mapping);
    await turn(selectRuntimeModel(models.find((m: any) => m.id === "gemini-4-argon"), "medium"), messages, sessionId, fixture, "ROUTING_TURN_OK");
    assert.equal(fixture.value, "AFTER");
    for (const name of ["read", "edit", "bash"]) assert.ok(report.ompCalls.includes(name));
    await runtime.close();
    runtime = createRuntime(report.restoredMode, mapping);
    messages.push({ role: "user", content: "Read probe://fixture again using the supplied tool, confirm it contains AFTER, then reply RESTORED_TURN_OK. Do not edit it or run commands.", timestamp: Date.now() });
    await turn(selectRuntimeModel(models.find((m: any) => m.id === "gemini-3.8-flash"), "medium"), messages, sessionId, fixture, "RESTORED_TURN_OK");
    assert.ok(report.sessions.some((s: any) => ["session/load", "session/resume"].includes(s.method)), "No live restoration RPC observed");
    for (const session of report.sessions) {
      assert.equal(session.systemAppend, true);
      assert.equal(session.taskMapping, true);
      assert.ok(session.eager.includes("pi-bridge"));
      if (session.mode === "disabled") assert.deepEqual(session.enabledTools, []);
      else { assert.equal(session.enabledTools, undefined); assert.deepEqual(session.disabledTools, []); }
    }
    assert.ok(report.serverTools.every((title: string) => /pi_(read|edit|bash)/.test(title)), JSON.stringify(report.serverTools));
    console.log(JSON.stringify(report));
    await runtime.close();
    runtime = undefined;
  }
} finally {
  await runtime?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
