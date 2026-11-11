// Offline verification of the real OMP /antigravity-acp quota entry point.
// The fake ACP connection answers /usage with a fixed official markdown reply;
// no Google process, model turn or account quota is used.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const omp = process.env.OMP_ACP_TEST_OMP_BIN ?? "omp";
const version = execFileSync(omp, ["--version"], { encoding: "utf8" }).trim();
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-quota-")));
const state = path.join(temporary, "agent/antigravity-acp-provider");
await fs.mkdir(state, { recursive: true });
await fs.writeFile(path.join(state, "context.json"), JSON.stringify({
  defaults: { contextWindow: 524288, maxTokens: 32000, usageMode: "off" },
  models: {},
}));
await fs.writeFile(path.join(state, "models-cache.json"), JSON.stringify({
  schemaVersion: 2,
  models: [{ modelId: "gemini-3.8-flash", name: "gemini-3.8-flash" }],
}));
const config = path.join(temporary, "config.json");
await fs.writeFile(config, JSON.stringify({
  compaction: { enabled: false, autoContinue: false },
  memory: { enabled: false },
}));
const quotaText = [
  "### Quota Limits",
  "- **Gemini Models**",
  "  - **weekly:** 96% remaining (resets Nov 14, 2026, 13:50 UTC)",
  "  - **5h:** 98% remaining (resets Nov 10, 2026, 16:39 UTC)",
  "- **Claude and GPT models**",
  "  - **weekly:** 100% remaining",
  "  - **5h:** 100% remaining",
  "- **Gemini 4 Argon**",
  "  - **weekly:** 29% remaining",
].join("\n");
const args = [
  "--no-extensions", "-e", path.join(root, "test/fixtures/session-switch-extension.ts"),
  "--model", "antigravity-acp/gemini-3.8-flash", "--smol", "antigravity-acp/gemini-3.8-flash",
  "--thinking", "off", "--no-tools", "--no-skills", "--no-rules", "--no-context-files",
  "--no-title", "--no-lsp", "--config", config, "--system-prompt", "OFFLINE_FIXTURE",
];
const env = {
  ...process.env,
  HOME: temporary,
  GEMINI_API_KEY: "offline-fixture",
  XDG_STATE_HOME: path.join(temporary, "state"),
  PI_CODING_AGENT_DIR: path.join(temporary, "agent"),
  GEMINI_HOME: path.join(temporary, "gemini"),
  AGY_ACP_BIN: process.execPath,
  OMP_ACP_SESSION_TEST_STATE: state,
  OMP_ACP_SESSION_TEST_QUOTA_TEXT: quotaText,
  OMP_ACP_IDLE_TIMEOUT_MS: "0",
  OMP_ACP_MAX_IDLE_RUNTIMES: "1",
  OMP_ACP_USAGE: "off",
};
const child = spawn(omp, ["--mode", "rpc", ...args], { cwd: temporary, stdio: ["pipe", "pipe", "pipe"], env });
const exited = once(child, "exit");
const responses = new Map<string, any>(), results = new Map<string, any>(), frames: any[] = [];
const waiters = new Set<() => void>();
let stderr = "", serial = 0, stopped = false;
void exited.then(() => { stopped = true; for (const notify of waiters) notify(); });
child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
createInterface({ input: child.stdout }).on("line", line => {
  try {
    const frame = JSON.parse(line);
    frames.push(frame);
    if (frame.type === "response") responses.set(frame.id, frame);
    if (frame.type === "prompt_result") results.set(frame.id, frame);
    for (const notify of waiters) notify();
  } catch {}
});
async function until<T>(get: () => T | undefined, label: string): Promise<T> {
  const ready = get();
  if (ready !== undefined) return ready;
  const done = Promise.withResolvers<T>();
  const timer = setTimeout(() => done.reject(new Error(`Timed out: ${label}\n${stderr}`)), 20000);
  const check = () => {
    const value = get();
    if (value !== undefined) done.resolve(value);
    else if (stopped) done.reject(new Error(`OMP exited while waiting for ${label}\n${stderr}`));
  };
  waiters.add(check);
  try { check(); return await done.promise; }
  finally { clearTimeout(timer); waiters.delete(check); }
}
async function command(type: string, fields: object = {}) {
  const id = String(++serial);
  child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
  const response = await until(() => responses.get(id), type);
  assert.equal(response.success, true, JSON.stringify(response));
  return { id, data: response.data };
}
async function trace() {
  try {
    return (await fs.readFile(path.join(state, "trace.jsonl"), "utf8")).trim().split("\n")
      .filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
try {
  const sent = await command("prompt", { message: "/antigravity-acp quota" });
  const result = await until(() => results.get(sent.id), "quota command result");
  assert.notEqual(result.status, "error", JSON.stringify(result));
  await delay(300);
  const notice = frames.filter(frame => frame.type === "extension_ui_request" && frame.method === "notify" &&
    typeof frame.message === "string" && frame.message.includes("Antigravity quota")).at(-1)?.message;
  assert.ok(notice, `no quota notice found\n${stderr}`);
  assert.match(notice, /Antigravity quota\n  Gemini Models\n    weekly\s+96% remaining · reset 2026-11-14T13:50:00\.000Z/);
  assert.match(notice, /    5h\s+98% remaining · reset 2026-11-10T16:39:00\.000Z/);
  assert.match(notice, /  Claude and GPT models\n    weekly\s+100% remaining\n    5h\s+100% remaining/);
  const argon = notice.slice(notice.indexOf("Gemini 4 Argon"));
  assert.match(argon, /weekly\s+29% remaining/);
  assert.doesNotMatch(argon, /5h/, "a weekly-only group must not invent a 5h row");
  assert.doesNotMatch(notice, /cache read|turns|input tokens/i, "quota output must not include usage counters");
  const prompts = (await trace()).filter(entry => entry.kind === "prompt");
  assert.equal(prompts.length, 1, "the quota path must send exactly one /usage prompt");
  assert.ok(JSON.stringify(prompts[0]!.prompt).includes("/usage"));
  console.log(JSON.stringify({ omp: version, prompts: prompts.length, groups: 3, argonWeeklyOnly: true }));
  console.log("Actual OMP /antigravity-acp quota entry: managed quota reply is parsed and rendered: PASS");
} catch (error) {
  console.error(JSON.stringify({
    notices: frames.filter(frame => frame.type === "notice"),
    recentFrames: frames.filter(frame => frame.type === "response" || frame.type === "prompt_result").slice(-5),
    trace: await trace(),
    stderr,
  }, null, 2));
  throw error;
} finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
  await fs.rm(temporary, { recursive: true, force: true });
}
