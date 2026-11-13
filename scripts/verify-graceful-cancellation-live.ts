// Opt-in: four Flash Low calls, or two with --text-only, through the adapter.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { registerOmpAdapter } from "../extension/index.ts";
import { Diagnostics } from "../extension/diagnostics.ts";
import { TierConnection, Type } from "../extension/runtime.mjs";
if (!process.argv.includes("--live")) throw new Error("Pass --live; uses Flash quota only.");
const timeoutMs = Number(process.env.OMP_ACP_PROBE_TIMEOUT_MS ?? 90_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) throw new Error("Invalid live probe timeout");
const state = await fs.mkdtemp(path.join(os.tmpdir(), "omp-graceful-cancel-live-"));
const sourceState = path.join(os.homedir(), ".omp/agent/antigravity-acp-provider");
await fs.copyFile(path.join(sourceState, "models-cache.json"), path.join(state, "models-cache.json"));
const hooks = new Map<string, Function>();
let provider: any;
const recorded: Array<{ stage: string; ms: number }> = [];
const originalRecord = Diagnostics.prototype.record;
Diagnostics.prototype.record = function(stage: string, ms: number) {
  recorded.push({ stage, ms });
  return originalRecord.call(this, stage, ms);
};
const seen = new Map<any, Set<string>>();
const calls: Array<{ id: string; prompt: any[]; stop?: string; started: number; aborted?: number; terminal?: number; cancels: number }> = [];
const original = TierConnection.prototype.prompt;
const originalCancel = TierConnection.prototype.cancel;
const cancelDescriptor = Object.getOwnPropertyDescriptor(TierConnection.prototype, "cancel");
TierConnection.prototype.cancel = async function(id: string) {
  const row = calls.findLast(row => row.id === id && row.terminal === undefined);
  if (row) row.cancels++;
  return originalCancel.call(this, id);
};
TierConnection.prototype.prompt = async function(request: any, signal: any) {
  const ids = seen.get(this) ?? new Set<string>(); ids.add(request.sessionId); seen.set(this, ids);
  const row: typeof calls[number] = { id: request.sessionId, prompt: request.prompt, started: performance.now(), cancels: 0 }; calls.push(row);
  const abort = () => { row.aborted ??= performance.now(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await original.call(this, request, signal);
    row.terminal = performance.now(); row.stop = response.stopReason; return response;
  } finally { signal?.removeEventListener("abort", abort); }
};
try {
  // Test-only policy; leave the user's saved files untouched.
  await fs.writeFile(path.join(state, "omp-tools.json"), JSON.stringify({ nativeTools: "disabled", debugToolUpdates: false }));
  await fs.writeFile(path.join(state, "context.json"), JSON.stringify({ defaults: { usageMode: "off" }, models: {} }));
  await fs.writeFile(path.join(state, "diagnostics.json"), JSON.stringify({ enabled: true }));
  await registerOmpAdapter({ on: (name: string, fn: Function) => hooks.set(name, fn),
    registerProvider: (_name: string, p: any) => { provider = p; }, registerTool() {}, registerCommand() {} }, state);
  const model = provider.models.find((m: any) => m.id === "gemini-3.8-flash"); assert.ok(model);
  for (const mode of process.argv.includes("--text-only") ? ["text"] : process.argv.includes("--tools-only") ? ["tools"] : ["text", "tools"]) {
    const id = `cancel-live-${mode}-${randomUUID()}`;
    const controller = new AbortController();
    const tools = mode === "tools" ? [{ name: "probe_read", description: "Return canned synthetic data only; no filesystem access.", parameters: Type.Object({ key: Type.String() }) }] : [];
    const messages: any[] = [{ role: "user", timestamp: Date.now(), content: mode === "tools"
      ? "Call the supplied probe_read tool with key fixture. Wait for its result before replying. Do not use any other tools."
      : "Write 1500 numbered sentences about counting. Do not use tools. Start immediately." }];
    const first = calls.length; let interrupted: any;
    for await (const event of provider.streamSimple(model, { messages, tools }, { sessionId: id, reasoning: "low",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]) })) {
      if ((mode === "text" && event.type === "text_delta") || (mode === "tools" && event.type === "toolcall_end")) controller.abort();
      if (event.type === "error") interrupted = structuredClone(event.error);
    }
    const interruptedDelivered = performance.now();
    assert.ok(controller.signal.aborted && interrupted,
      `${mode} did not reach a cancellable output chunk; elapsed=${Math.round(interruptedDelivered - (calls[first]?.started ?? interruptedDelivered))}ms; ` +
      `terminal=${calls[first]?.stop ?? "none"}; error=${String(interrupted?.errorMessage ?? "none").replace(/https?:\/\/\S+/g, "[URL]").slice(0, 160)}`);
    assert.equal(calls[first].stop, "cancelled", "Official terminal acknowledgement must survive the client wrapper");
    messages.push(interrupted, { role: "user", timestamp: Date.now(), content: "The previous request is cancelled. New request: reply with exactly NEW_REQUEST_OK. Do not use tools or resume the previous request." });
    let answer: any;
    const followupSubmitted = performance.now();
    for await (const event of provider.streamSimple(model, { messages, tools }, { sessionId: id, reasoning: "low", signal: AbortSignal.timeout(timeoutMs) })) {
      if (event.type === "error") throw new Error(event.error.errorMessage);
      if (event.type === "done") answer = event.message;
    }
    assert.equal(answer?.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim(), "NEW_REQUEST_OK");
    assert.equal(calls[first + 1].id, calls[first].id, "Actual OMP adapter must preserve the ACP session after a clean cancellation");
    assert.ok(!calls[first + 1].prompt.some(b => b.type === "resource" && b.resource?.uri === "urn:omp:antigravity-acp:history"), "No cold history replay after confirmed cancellation");
    const round = (ms: number) => +ms.toFixed(3);
    console.log(JSON.stringify({ mode, officialStop: calls[first].stop, sameSession: true, coldHistoryReplay: false, answer: "NEW_REQUEST_OK",
      cancelNotifications: calls[first].cancels, cancelToTerminalMs: round(calls[first].terminal! - calls[first].aborted!),
      terminalToInterruptedDeliveryMs: round(interruptedDelivered - calls[first].terminal!),
      followupLocalDispatchMs: round(calls[first + 1].started - followupSubmitted),
      followupTotalMs: round(performance.now() - followupSubmitted) }));
    await hooks.get("session_shutdown")?.({}, { sessionManager: { getSessionId: () => id } });
  }
  const stages = [...new Set(recorded.map(sample => sample.stage))].sort();
  assert.ok(stages.includes("acp.cancel-confirmation"), "the adapter must record the cancellation confirmation");
  console.log(JSON.stringify({ diagnostics: { samples: recorded.length, stages } }));
} finally {
  // Only this isolated probe's mappings are disposable. Dropping them before
  // retirement allows the new mapped-session protection to keep user data safe.
  await fs.rm(path.join(state, "sessions.json"), { force: true });
  for (const [c, ids] of seen) { for (const id of ids) await c.discardSession(id); await c.close(); await c.cleanup?.stop(); }
  Diagnostics.prototype.record = originalRecord;
  TierConnection.prototype.prompt = original;
  if (cancelDescriptor) Object.defineProperty(TierConnection.prototype, "cancel", cancelDescriptor);
  else delete (TierConnection.prototype as any).cancel;
  await fs.rm(state, { recursive: true, force: true });
}
