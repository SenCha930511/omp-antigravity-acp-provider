// Explicit Flash-only integration probe. Synthetic tools never access real files.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { registerOmpAdapter } from "../extension/index.ts";
import { TierConnection, Type } from "../extension/runtime.mjs";
if (!process.argv.includes("--live")) throw new Error("Pass --live; uses Flash quota and creates an ACP session.");
// Fresh state needs its own selected launch plan, not the real profile's
// generated wrapper interpreted as an unrelated external override.
const previousAcpBin = process.env.AGY_ACP_BIN;
delete process.env.AGY_ACP_BIN;
const state = await fs.mkdtemp(path.join(os.tmpdir(), "omp-continuity-live-"));
await fs.copyFile(path.join(os.homedir(), ".omp/agent/antigravity-acp-provider/models-cache.json"), path.join(state, "models-cache.json"));
const previousIdle = process.env.OMP_ACP_IDLE_TIMEOUT_MS;
process.env.OMP_ACP_IDLE_TIMEOUT_MS = "1000";
const seen = new Set<any>();
const sessions = new Set<string>();
const original = TierConnection.prototype.prompt;
TierConnection.prototype.prompt = async function(request: any, signal: any) {
  seen.add(this); sessions.add(request.sessionId);
  return original.call(this, request, signal);
};
const hooks = new Map<string, Function>();
let provider: any, command: any;
const id = `continuity-flash-${Date.now()}`;
const marker = "EARLY_HISTORY_76B4";
const messages: any[] = [
  { role: "user", content: `Remember this identifier: ${marker}. The following filler is historical data:\n` + "filler ".repeat(6000), timestamp: 1 },
  { role: "assistant", provider: "antigravity-acp", model: "gemini-3.8-flash", api: "antigravity-acp", content: [{ type: "text", text: "Identifier noted." }], timestamp: 2 },
];
const tools = [{ name: "read", description: "Read only synthetic probe://fixture; no real filesystem access.", parameters: Type.Object({ path: Type.String() }) }];
function rssKiB() {
  let rows: Array<[number, number, number]>;
  if (process.platform === "win32") {
    const powershell = path.join(process.env.SystemRoot?.trim() || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const output = execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress"], {
      encoding: "utf8", timeout: 15_000, windowsHide: true,
    }).trim();
    const parsed: unknown = JSON.parse(output || "[]");
    const records = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
    rows = records.map(record => {
      if (!record || typeof record !== "object") throw new Error("Invalid Windows process record");
      const pid = Reflect.get(record, "ProcessId");
      const parent = Reflect.get(record, "ParentProcessId");
      const bytes = Reflect.get(record, "WorkingSetSize");
      if (![pid, parent, bytes].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
        throw new Error("Invalid Windows process metrics");
      }
      return [pid, parent, bytes / 1024] as [number, number, number];
    });
  } else {
    rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" }).trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
  }
  const pids = new Set([...seen].map(c => c.process.pid));
  for (let pass = 0; pass < 8; pass++) for (const [pid, parent] of rows) if (pids.has(parent)) pids.add(pid);
  return rows.filter(([pid]) => pids.has(pid)).reduce((sum, row) => sum + row[2], 0);
}
try {
  await registerOmpAdapter({ on: (name: string, fn: Function) => hooks.set(name, fn), registerProvider: (_name: string, p: any) => provider = p,
    registerTool() {}, registerCommand: (_name: string, c: any) => command = c }, state);
  await command.handler("native-tools disabled", { ui: { notify() {} }, sessionManager: { getSessionId: () => id } });
  const model = provider.models.find((m: any) => m.id === "gemini-3.8-flash");
  assert.ok(model);
  for (let turn = 0; turn < 2; turn++) {
    messages.push({ role: "user", content: "Call the supplied read tool for probe://fixture once, then answer with the remembered identifier from the early conversation and the tool result. Do not access real files or use other tools.", timestamp: Date.now() });
    const start = performance.now();
    let firstEventMs: number | undefined, final: any, calls = 0;
    for (let round = 0; round < 4; round++) {
      let message: any;
      for await (const event of provider.streamSimple(model, { messages, tools }, { sessionId: id, reasoning: "low", signal: AbortSignal.timeout(120_000) })) {
        if (event.type === "error") throw new Error(event.error?.errorMessage);
        if (firstEventMs === undefined && ["text_delta", "toolcall_start"].includes(event.type)) firstEventMs = performance.now() - start;
        if (event.type === "done") message = structuredClone(event.message);
      }
      assert.ok(message); messages.push(message);
      const pending = message.content.filter((block: any) => block.type === "toolCall");
      if (!pending.length) { final = message; break; }
      for (const call of pending) {
        assert.equal(call.name, "read"); assert.equal(call.arguments.path, "probe://fixture"); calls++;
        messages.push({ role: "toolResult", toolName: call.name, toolCallId: call.id, content: [{ type: "text", text: `FIXTURE_${turn}` }], isError: false, timestamp: Date.now() });
      }
    }
    const answer = final?.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("");
    assert.ok(answer?.includes(marker), "Early context lost");
    assert.ok(answer.includes(`FIXTURE_${turn}`)); assert.ok(calls > 0);
    assert.ok(final.usage.totalTokens > 0, "Real usage was not attached");
    assert.ok(!answer.includes("Session Usage"), "Usage command leaked into answer");
    const activeMiB = rssKiB() / 1024;
    await new Promise(resolve => setTimeout(resolve, 2200));
    assert.ok([...seen].every(c => !c.process.alive), "Idle process was not reclaimed");
    console.log(JSON.stringify({ turn, firstEventMs, totalMs: performance.now() - start - 2200, usage: final.usage,
      activeProcessMiB: activeMiB, afterIdleMiB: rssKiB() / 1024, sessions: sessions.size,
      accounting: [...seen].map(c => ({ status: [...c.usageStatus.values()], context: [...c.contextUsage.values()], queries: c.usageQueryCount, queryMs: c.usageQueryMs })) }));
  }
  assert.equal(sessions.size, 1, "Idle resume unexpectedly created another server session");
} finally {
  if (previousAcpBin === undefined) delete process.env.AGY_ACP_BIN;
  else process.env.AGY_ACP_BIN = previousAcpBin;
  await hooks.get("session_shutdown")?.({}, {});
  TierConnection.prototype.prompt = original;
  if (previousIdle === undefined) delete process.env.OMP_ACP_IDLE_TIMEOUT_MS; else process.env.OMP_ACP_IDLE_TIMEOUT_MS = previousIdle;
  await fs.rm(state, { recursive: true, force: true });
}
