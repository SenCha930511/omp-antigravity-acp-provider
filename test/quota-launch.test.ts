// The quota ACP session must spawn the same verified launch record as
// inference, never a fixture-only direct command. No real inference runs.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerOmpAdapter } from "../extension/index.ts";
import { secretService, type OmpCommandContext } from "../extension/auth-sync.ts";
import { inspectRuntimeLaunchPlan, resolveLaunchTarget, type DirectCommand } from "../extension/runtime/launch.ts";
import type { TierConnection } from "../extension/runtime.mjs";

interface QuotaUsageProvider {
  fetchUsage: (params: { signal?: AbortSignal }) => Promise<{ limits: unknown[] } | null>;
}

interface CapturedConnection {
  launch?: DirectCommand;
  command?: string;
  args?: string[];
}

const quotaText = [
  "### Quota Limits",
  "- **Gemini Models**",
  "  - **weekly:** 96% remaining (resets Nov 14, 2026, 13:50 UTC)",
].join("\n");

function quotaConnection(captured: CapturedConnection[], options: ConstructorParameters<typeof TierConnection>[0]): TierConnection {
  const raw = options as unknown as Record<string, unknown>;
  captured.push({
    ...(typeof raw.launch === "object" && raw.launch !== null ? { launch: raw.launch as DirectCommand } : {}),
    ...(typeof raw.command === "string" ? { command: raw.command } : {}),
    ...(Array.isArray(raw.args) ? { args: raw.args as string[] } : {}),
  });
  const handlers = raw.handlers as { onUpdate?: (notification: unknown) => void } | undefined;
  let sessionId = "";
  const connection = {
    process: { alive: true, pid: 1, generation: 1, exited: new Promise(() => {}) },
    async initialize() { return { protocolVersion: 1, agentCapabilities: { sessionCapabilities: {} } }; },
    async authenticate() { return undefined; },
    async newSession() {
      sessionId = "quota-fixture";
      return { sessionId, models: { currentModelId: "gemini-3.8-flash", availableModels: [{ modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }] } };
    },
    getSessionState() { return {}; },
    async setModel() { return undefined; },
    async waitForUsageCommand() { return true; },
    async promptWithoutUsageDeltas() {
      handlers?.onUpdate?.({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: quotaText } } });
      return { stopReason: "end_turn" };
    },
    async discardSession() { return undefined; },
    async close() { connection.process.alive = false; },
  };
  return connection as unknown as TierConnection;
}

test("quota ACP sessions use the verified launch record from the selected plan", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-quota-launch-"));
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
    secretPresent: secretService.present,
    secretRemove: secretService.remove,
  };
  process.env.AGY_ACP_BIN = cli;
  process.env.GEMINI_HOME = geminiHome;
  process.env.GEMINI_API_KEY = "offline-fixture";
  secretService.present = async () => false;
  secretService.remove = async () => undefined;
  const captured: CapturedConnection[] = [];
  const hooks = new Map<string, (event: unknown, ctx: OmpCommandContext) => unknown>();
  let provider: { usage?: QuotaUsageProvider } | undefined;
  try {
    await registerOmpAdapter({
      on: (name, handler) => { hooks.set(name, handler); },
      registerTool() {},
      registerCommand() {},
      registerProvider: (_name, value) => { provider = value as typeof provider; },
    }, state, (options: ConstructorParameters<typeof TierConnection>[0]) => quotaConnection(captured, options));

    const usage = provider?.usage;
    if (!usage) throw new Error("provider usage was not registered");
    const report = await usage.fetchUsage({});
    assert.ok(report && report.limits.length > 0, "the fixture quota reply must parse into a report");

    const plan = await inspectRuntimeLaunchPlan(state, { env: process.env });
    const expected = resolveLaunchTarget(plan);
    assert.equal(captured.length, 1, "exactly one quota ACP connection");
    assert.deepEqual(captured[0]?.launch, expected);
    assert.equal(captured[0]?.command, undefined, "quota must not use the fixture-only direct command");
    assert.equal(captured[0]?.args, undefined);
    assert.equal(expected.command, cli);
  } finally {
    if (previous.AGY_ACP_BIN === undefined) delete process.env.AGY_ACP_BIN; else process.env.AGY_ACP_BIN = previous.AGY_ACP_BIN;
    if (previous.GEMINI_HOME === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = previous.GEMINI_HOME;
    if (previous.GEMINI_API_KEY === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous.GEMINI_API_KEY;
    secretService.present = previous.secretPresent;
    secretService.remove = previous.secretRemove;
    await hooks.get("session_shutdown")?.({}, {} as OmpCommandContext);
    await fs.rm(root, { recursive: true, force: true });
  }
});
