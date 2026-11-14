import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const bundle = process.argv[2];
if (!bundle) throw new Error("Usage: node scripts/capture-runtime-contract.mjs ABSOLUTE_RUNTIME_BUNDLE");
const { AcpSessionStore, AntigravityRuntime } = await import(pathToFileURL(path.resolve(bundle)).href);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "acp-runtime-contract-"));
const store = new AcpSessionStore(path.join(root, "sessions.json"));
const actions = [];
const prompts = [];
const state = {
  modes: { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "yolo" }, { id: "default", name: "default" }] },
  models: { currentModelId: "fixture-model", availableModels: [{ modelId: "fixture-model", name: "Fixture" }] },
};
const model = {
  id: "fixture-model",
  name: "Fixture",
  api: "antigravity-acp",
  provider: "antigravity-acp",
  contextWindow: 524_288,
  maxTokens: 32_000,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function connectionFactory(options) {
  return {
    process: { alive: true, pid: 1, exited: new Promise(() => {}) },
    activePrompts: 0,
    async initialize() {
      actions.push("initialize");
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {} },
          promptCapabilities: { embeddedContext: true, image: true },
          mcpCapabilities: { http: false },
        },
      };
    },
    getSessionState() { return state; },
    async newSession() {
      actions.push("new");
      return { sessionId: "fixture-acp-session", ...state };
    },
    async resumeSession(id) {
      actions.push(`resume:${id}`);
      return state;
    },
    async loadSession(id) {
      actions.push(`load:${id}`);
      return state;
    },
    async setModel() {},
    async setMode() {},
    holdPromptWatchdog() { return () => {}; },
    async prompt(request) {
      this.activePrompts++;
      prompts.push(request);
      this.activePrompts--;
      options.handlers.onUpdate({
        sessionId: request.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ACK:${prompts.length}` } },
      });
      return { stopReason: "end_turn" };
    },
    async close() { this.process.alive = false; },
  };
}

async function turn(runtime, messages) {
  const events = [];
  for await (const event of runtime.stream(model, { systemPrompt: "FIXTURE_RULES", tools: [], messages }, { sessionId: "fixture-omp-session" }).stream) {
    if (event.type === "error") throw new Error(event.error.errorMessage);
    events.push(event);
  }
  return events;
}

try {
  const firstRuntime = new AntigravityRuntime(connectionFactory, "yolo", store);
  const first = await turn(firstRuntime, [{ role: "user", content: "REQUEST_ONE", timestamp: 1 }]);
  const assistant = first.find(event => event.type === "done")?.message;
  assert.ok(assistant);
  const second = await turn(firstRuntime, [
    { role: "user", content: "REQUEST_ONE", timestamp: 1 },
    assistant,
    { role: "user", content: "REQUEST_TWO", timestamp: 2 },
  ]);
  await store.flush();
  await firstRuntime.close();

  const secondRuntime = new AntigravityRuntime(connectionFactory, "yolo", store);
  const third = await turn(secondRuntime, [
    { role: "user", content: "REQUEST_ONE", timestamp: 1 },
    assistant,
    { role: "user", content: "REQUEST_TWO", timestamp: 2 },
    ...second.filter(event => event.type === "done").map(event => event.message),
    { role: "user", content: "REQUEST_THREE", timestamp: 3 },
  ]);
  await store.flush();
  await secondRuntime.close();

  const clean = value => JSON.stringify(value, (key, item) => {
    if (["timestamp", "durationMs", "completedAt", "credentialId"].includes(key)) return undefined;
    return item;
  }, 2);
  console.log(clean({
    actions,
    prompts,
    events: [first, second, third].map(events => events.filter(event => ["done", "error"].includes(event.type))),
  }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
