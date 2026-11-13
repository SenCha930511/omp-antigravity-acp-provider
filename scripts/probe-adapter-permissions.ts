import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveAcpPermissionProfile, resolveLaunchSpawn, resolveManagedAcpCommand, resolveRuntimeLaunchPlan, type RuntimeLaunchPlan } from "../extension/runtime/launch.ts";
import { resolveAntigravityAcpDirectory } from "../extension/runtime/acp/antigravity.ts";

if (!process.argv.includes("--live")) {
  throw new Error("Pass --live explicitly; this probe creates ACP sessions but intercepts every prompt before the ACP RPC.");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-adapter-permissions-"));
const sentinel = "OMP_PROBE_BEFORE_SESSION_PROMPT";
const { AntigravityRuntime, TierConnection, Type } = await import(pathToFileURL(path.join(root, "extension/runtime.mjs")).href);
const managed = path.join(os.homedir(), ".local", "opt", "agy-acp", "current", "agy_acp_server.par");
const managedRecord = JSON.parse(fs.readFileSync(path.join(path.dirname(managed), "install-integrity.json"), "utf8")) as { version?: unknown };
if (typeof managedRecord.version !== "string") throw new Error("Managed ACP install record has no version");
const tools = [{ name: "read", description: "Read a synthetic value without executing it.", parameters: Type.Object({ path: Type.String() }) }];

type RequestedMode = "default" | "auto_edit" | "yolo";
interface ProbeCase {
  channel: "cli" | "managed";
  requested: RequestedMode;
  modelId: string;
}

function removeConversation(sessionId: string | undefined) {
  if (!sessionId || !/^[0-9a-f-]{36}$/iu.test(sessionId)) return;
  for (const suffix of [".db", ".db-shm", ".db-wal", ".meta"]) {
    fs.rmSync(path.join(resolveAntigravityAcpDirectory(), "conversations", sessionId + suffix), { force: true });
  }
}

async function probe(plan: RuntimeLaunchPlan, fixture: ProbeCase) {
  const profile = resolveAcpPermissionProfile(plan, fixture.requested);
  const launch = resolveLaunchSpawn(plan);
  let acpSessionId: string | undefined;
  let promptAttempts = 0;
  const runtime = new AntigravityRuntime(options => {
    const connection = new TierConnection({
      ...options,
      command: launch.command,
      args: [...launch.args],
      env: {
        ...process.env,
        ...options.env,
        OMP_ACP_DANGEROUSLY_SKIP_PERMISSIONS: profile.autoApproveProcess ? "1" : "",
      },
    });
    const newSession = connection.newSession.bind(connection);
    connection.newSession = async (...args) => {
      const session = await newSession(...args);
      acpSessionId = session.sessionId;
      return session;
    };
    connection.prompt = async () => { promptAttempts += 1; throw new Error(sentinel); };
    return connection;
  }, profile.wireMode);
  const model = {
    id: fixture.modelId,
    name: "No-inference probe model",
    api: "antigravity-acp",
    provider: "antigravity-acp",
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  try {
    let reachedSentinel = false;
    for await (const event of runtime.stream(model, {
      messages: [{ role: "user", content: "This text must never reach session/prompt.", timestamp: 1 }],
      tools,
    }, { sessionId: `adapter-probe-${fixture.channel}-${fixture.requested}` }).stream) {
      if (event.type !== "error") continue;
      const message = event.error instanceof Error ? event.error.message : JSON.stringify(event.error);
      if (message.includes(sentinel)) reachedSentinel = true;
      else throw event.error;
    }
    assert.ok(reachedSentinel, `Failed before the no-prompt sentinel: ${fixture.channel} ${fixture.requested}`);
    assert.equal(promptAttempts, 1);
    const snapshot = await runtime.snapshot();
    assert.equal(snapshot.permissionMode, profile.wireMode);
    assert.equal(snapshot.processes.length, 1);
    assert.equal(snapshot.processes[0]!.confirmedPermissionMode, profile.wireMode);
    assert.equal(snapshot.processes[0]!.mcpHttp, true);
    assert.deepEqual(snapshot.processes[0]!.omittedTools, []);
    console.log(JSON.stringify({
      channel: fixture.channel,
      requestedMode: fixture.requested,
      wireMode: profile.wireMode,
      autoApproveProcess: profile.autoApproveProcess,
      acpSessionId,
      runtimeVersion: preference.cliVersion ?? preference.managedVersion,
      mcpHttp: true,
      prePromptSentinelReached: reachedSentinel,
      interceptedPromptCalls: promptAttempts,
    }));
  } finally {
    await runtime.close();
    removeConversation(acpSessionId);
  }
}

try {
  const launchEnv = { ...process.env };
  delete launchEnv.AGY_ACP_BIN;
  const cliPlan = await resolveRuntimeLaunchPlan(stateDir, { env: launchEnv });
  assert.equal(cliPlan.source, "cli", "The installed CLI must be newer for this live CLI probe");
  const repeatedCli = await resolveRuntimeLaunchPlan(stateDir, { env: launchEnv });
  assert.equal(repeatedCli.source, "cli", "A wrapper generated by this adapter must retain its CLI profile");
  for (const requested of ["default", "auto_edit", "yolo"] as const) {
    await probe(repeatedCli, { channel: "cli", requested, modelId: "gemini-4-argon" });
  }
  const managedCommand = resolveManagedAcpCommand();
  if (!managedCommand) throw new Error("The managed ACP runtime is not installed");
  const managedPlan: RuntimeLaunchPlan = {
    source: "managed",
    target: { kind: "direct", value: managedCommand },
    quota: { kind: "acp", value: managedCommand },
    installManaged: false,
    managedVersion: managedRecord.version,
  };
  for (const requested of ["default", "auto_edit", "yolo"] as const) {
    await probe(managedPlan, { channel: "managed", requested, modelId: "gemini-3.8-flash" });
  }
} finally {
  fs.rmSync(stateDir, { recursive: true, force: true });
}
