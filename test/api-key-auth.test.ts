// An OMP-stored Gemini API key must reach inference and discovery without a
// local Google login. These fixtures never spawn ACP and never read credentials.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CatalogStore } from "../extension/catalog-store.ts";
import { keychain, secretService } from "../extension/auth-sync.ts";
import type { OmpCommandContext } from "../extension/auth-sync.ts";
import { registerOmpAdapter } from "../extension/index.ts";
import { MANAGED_AUTH_MARKER, TierConnection, usableApiKey } from "../extension/runtime.mjs";
import type { SessionCleanup } from "../extension/session-cleanup.ts";

type AuthRequest = { methodId: string; _meta?: Record<string, unknown> };

function discoveryConnection(authRequests: AuthRequest[]) {
  return {
    async initialize() {
      return {
        protocolVersion: 1,
        authMethods: [{ id: "api-key", name: "Gemini API key", _meta: { "api-key": {} } }],
        agentCapabilities: {},
      };
    },
    async authenticate(request: AuthRequest) { authRequests.push(request); },
    async newSession() {
      return { sessionId: "discovery", models: { availableModels: [{ modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }] } };
    },
    async discardSession() { return undefined; },
    async close() { return undefined; },
    getSessionState() { return {}; },
  } as unknown as TierConnection;
}

function inferenceConnection(authRequests: AuthRequest[]) {
  const modes = { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] };
  const models = { currentModelId: "gemini-3.8-flash", availableModels: [{ modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }] };
  let sessionId = "";
  const connection = {
    process: { alive: true, pid: 1, generation: 1, exited: Promise.withResolvers<never>().promise },
    async initialize() {
      return {
        protocolVersion: 1,
        authMethods: [{ id: "api-key", name: "Gemini API key", _meta: { "api-key": {} } }],
        agentCapabilities: { sessionCapabilities: {}, promptCapabilities: {} },
      };
    },
    async authenticate(request: AuthRequest) { authRequests.push(request); },
    async newSession() { sessionId = "fixture"; return { sessionId, modes, models }; },
    getSessionState() { return { modes, models }; },
    async setMode() { return undefined; },
    async setModel() { return undefined; },
    holdPromptWatchdog() { return () => undefined; },
    async prompt() {
      return { stopReason: "end_turn" };
    },
    async cancel() { return undefined; },
    async closeSession() { return undefined; },
    async discardSession() { return undefined; },
    async retireForReplacement() { return undefined; },
    async confirmReplacement() { return undefined; },
    async close() { connection.process.alive = false; },
  };
  return connection as unknown as TierConnection;
}

async function adapterHarness(authRequests: AuthRequest[], create: () => TierConnection) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-api-key-"));
  const state = path.join(root, "state");
  const geminiHome = path.join(root, "gemini");
  const cli = path.join(root, "agy-fixture");
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(cli, "#!/bin/sh\nexit 0\n");
  await fs.chmod(cli, 0o755);
  const previous = {
    AGY_ACP_BIN: process.env.AGY_ACP_BIN,
    GEMINI_HOME: process.env.GEMINI_HOME,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    present: keychain.present,
    secretPresent: secretService.present,
    secretRemove: secretService.remove,
  };
  process.env.AGY_ACP_BIN = cli;
  process.env.GEMINI_HOME = geminiHome;
  delete process.env.GEMINI_API_KEY;
  keychain.present = async () => false;
  secretService.present = async () => false;
  secretService.remove = async () => undefined;
  const hooks = new Map<string, (event: unknown, ctx: OmpCommandContext) => unknown>();
  let provider: {
    models: Array<{ id: string }>;
    streamSimple: (model: { id: string }, context: unknown, options: { apiKey?: string }) => AsyncIterable<{ type: string; error?: { errorMessage?: string } }>;
  } | undefined;
  let spawns = 0;
  try {
    await registerOmpAdapter({
      on: (name, handler) => { hooks.set(name, handler); },
      registerTool() {},
      registerCommand() {},
      registerProvider: (_name, value) => { provider = value as typeof provider; },
    }, state, () => { spawns++; return create(); });
  } catch (error) {
    await restore();
    throw error;
  }
  async function restore() {
    if (previous.AGY_ACP_BIN === undefined) delete process.env.AGY_ACP_BIN; else process.env.AGY_ACP_BIN = previous.AGY_ACP_BIN;
    if (previous.GEMINI_HOME === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = previous.GEMINI_HOME;
    if (previous.GEMINI_API_KEY === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous.GEMINI_API_KEY;
    keychain.present = previous.present;
    secretService.present = previous.secretPresent;
    secretService.remove = previous.secretRemove;
    await hooks.get("session_shutdown")?.({}, {} as OmpCommandContext);
    await fs.rm(root, { recursive: true, force: true });
  }
  if (!provider) throw new Error("provider was not registered");
  return { provider, spawns: () => spawns, authRequests, restore };
}

async function stream(harness: Awaited<ReturnType<typeof adapterHarness>>, apiKey?: string) {
  const events: Array<{ type: string; error?: { errorMessage?: string } }> = [];
  const options = apiKey === undefined ? {} : { apiKey };
  for await (const event of harness.provider.streamSimple(harness.provider.models[0]!,
    { messages: [{ role: "user", content: "synthetic", timestamp: 1 }], tools: [] }, options)) {
    events.push(event);
  }
  return events;
}

test("only a non-empty trimmed key different from the managed marker is a credential", () => {
  assert.equal(usableApiKey(undefined), undefined);
  assert.equal(usableApiKey(""), undefined);
  assert.equal(usableApiKey("   "), undefined);
  assert.equal(usableApiKey(MANAGED_AUTH_MARKER), undefined);
  assert.equal(usableApiKey(` ${MANAGED_AUTH_MARKER} `), undefined);
  assert.equal(usableApiKey("  AIza-stored  "), "AIza-stored");
});

test("catalog discovery and refresh authenticate with the request key instead of local login", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-api-key-catalog-"));
  const requests: AuthRequest[] = [];
  let received: string | undefined;
  try {
    const store = new CatalogStore(path.join(root, "models.json"), {} as unknown as SessionCleanup,
      async () => {},
      () => [],
      async apiKey => {
        received = apiKey;
        if (!usableApiKey(apiKey)) throw new Error("not signed in");
      },
      () => discoveryConnection(requests));
    const models = await store.discoverModels("  AIza-stored  ");
    assert.equal(models[0]?.modelId, "gemini-3.8-flash");
    assert.equal(received, "  AIza-stored  ");
    assert.deepEqual(requests, [{ methodId: "api-key", _meta: { "api-key": "AIza-stored" } }]);

    requests.length = 0;
    const refreshed = await store.refresh({ defaults: {}, models: {} }, " AIza-refresh ");
    assert.equal(refreshed[0]?.id, "gemini-3.8-flash");
    assert.equal(received, " AIza-refresh ");
    assert.deepEqual(requests, [{ methodId: "api-key", _meta: { "api-key": "AIza-refresh" } }]);
    await assert.rejects(store.discoverModels(MANAGED_AUTH_MARKER), /not signed in/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an OMP-stored key authenticates inference with no local ACP auth", async () => {
  const requests: AuthRequest[] = [];
  const harness = await adapterHarness(requests, () => inferenceConnection(requests));
  try {
    const events = await stream(harness, "  AIza-stored  ");
    assert.equal(events.some(event => event.type === "error"), false, JSON.stringify(events));
    assert.equal(harness.spawns(), 1);
    assert.deepEqual(requests, [{ methodId: "api-key", _meta: { "api-key": "AIza-stored" } }]);
  } finally { await harness.restore(); }
});

test("the managed marker is not accepted in place of a real key", async () => {
  const requests: AuthRequest[] = [];
  const harness = await adapterHarness(requests, () => inferenceConnection(requests));
  try {
    for (const apiKey of [undefined, MANAGED_AUTH_MARKER]) {
      const events = await stream(harness, apiKey);
      assert.match(events.find(event => event.type === "error")?.error?.errorMessage ?? "", /not signed in.*\/login/i);
    }
    assert.equal(harness.spawns(), 0);
    assert.deepEqual(requests, []);
  } finally { await harness.restore(); }
});
