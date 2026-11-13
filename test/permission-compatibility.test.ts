import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, Message, StreamEvent, ToolCall } from "@earendil-works/pi-ai";

import { resolveAcpPermissionProfile } from "../extension/runtime/launch.ts";
import { AntigravityRuntime, TierConnection, Type } from "../extension/runtime.mjs";

type RequestedMode = "default" | "auto_edit" | "yolo";

const root = process.cwd();
const model = {
  id: "gemini-3.8-flash",
  name: "Synthetic Flash",
  api: "antigravity-acp",
  provider: "antigravity-acp",
  contextWindow: 524288,
  maxTokens: 32000,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const read = {
  name: "read",
  description: "Read a synthetic path through the real MCP bridge.",
  parameters: Type.Object({ path: Type.String() }),
};
const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });

test("CLI 1.5.3 maps requested modes to its real wire and process policies", () => {
  const preference = { source: "cli", cliPath: "/synthetic/agy", cliVersion: "1.5.3" } as const;
  assert.deepEqual(resolveAcpPermissionProfile(preference, "yolo"), {
    requestedMode: "yolo", wireMode: "default", autoApproveProcess: true,
  });
  assert.deepEqual(resolveAcpPermissionProfile(preference, "auto_edit"), {
    requestedMode: "auto_edit", wireMode: "accept-edits", autoApproveProcess: false,
  });
  assert.deepEqual(resolveAcpPermissionProfile(preference, "default"), {
    requestedMode: "default", wireMode: "default", autoApproveProcess: false,
  });
});

test("managed 1.4.5, older CLI, and explicit env runtimes preserve requested mode IDs", () => {
  const preferences = [
    { source: "managed", managedVersion: "1.4.5" },
    { source: "cli", cliPath: "/synthetic/old-agy", cliVersion: "1.5.2" },
    { source: "cli", cliPath: "/synthetic/old-agy", cliVersion: "1.4.5" },
    { source: "env", cliPath: "/synthetic/custom-agy", cliVersion: "9.9.9" },
    { source: "env" },
  ] as const;
  for (const preference of preferences) {
    for (const requested of ["default", "auto_edit", "yolo"] as const) {
      assert.deepEqual(resolveAcpPermissionProfile(preference, requested), {
        requestedMode: requested, wireMode: requested, autoApproveProcess: false,
      }, `${preference.source} ${preference.source === "managed" ? preference.managedVersion : preference.cliVersion} ${requested}`);
    }
  }
});

for (const fixture of [
  { name: "legacy official identity", agentName: "antigravity-acp", mcpHttp: undefined, expected: true },
  { name: "explicit MCP refusal", agentName: "Antigravity ACP Server", mcpHttp: "false", expected: false },
  { name: "unknown identity", agentName: "untrusted-agent", mcpHttp: undefined, expected: undefined },
] as const) {
  test(`MCP normalization respects ${fixture.name}`, async t => {
    const connection = new TierConnection({
      cwd: root,
      command: process.execPath,
      args: [path.join(root, "scripts/fake-agy.mjs")],
      env: { ...process.env, FAKE_AGY_PROFILE: "cli-1.5.3", FAKE_AGY_AGENT_NAME: fixture.agentName, FAKE_AGY_MCP_HTTP: fixture.mcpHttp },
      handlers: { onPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
    });
    t.after(() => connection.close());
    const initialized = await connection.initialize();
    assert.equal(initialized.agentCapabilities.mcpCapabilities?.http, fixture.expected);
  });
}

interface WireCase {
  name: string;
  requested: RequestedMode;
  preference: { source: "cli"; cliPath: string; cliVersion: string } | { source: "managed"; managedVersion: string };
  modern: boolean;
  expectedWireMode: string;
  autoApproveMarker: string;
}

for (const fixture of [
  {
    name: "CLI yolo", requested: "yolo", modern: true, expectedWireMode: "default", autoApproveMarker: "1",
    preference: { source: "cli", cliPath: "/synthetic/agy", cliVersion: "1.5.3" },
  },
  {
    name: "CLI auto_edit", requested: "auto_edit", modern: true, expectedWireMode: "accept-edits", autoApproveMarker: "",
    preference: { source: "cli", cliPath: "/synthetic/agy", cliVersion: "1.5.3" },
  },
  {
    name: "CLI default", requested: "default", modern: true, expectedWireMode: "default", autoApproveMarker: "",
    preference: { source: "cli", cliPath: "/synthetic/agy", cliVersion: "1.5.3" },
  },
  {
    name: "managed yolo", requested: "yolo", modern: false, expectedWireMode: "yolo", autoApproveMarker: "",
    preference: { source: "managed", managedVersion: "1.4.5" },
  },
] satisfies WireCase[]) {
  test(`${fixture.name} negotiates its wire mode and executes a synthetic MCP read`, async t => {
    const profile = resolveAcpPermissionProfile(fixture.preference, fixture.requested);
    assert.equal(profile.wireMode, fixture.expectedWireMode);
    assert.equal(profile.autoApproveProcess, fixture.autoApproveMarker === "1");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-permission-wire-"));
    const logFile = path.join(directory, "fake.jsonl");
    const env = {
      ...process.env,
      FAKE_AGY_LOG: logFile,
      FAKE_AGY_PROFILE: fixture.modern ? "cli-1.5.3" : "legacy",
      OMP_ACP_DANGEROUSLY_SKIP_PERMISSIONS: fixture.autoApproveMarker,
    };
    const runtime = new AntigravityRuntime(options => new TierConnection({
      ...options,
      command: process.execPath,
      args: [path.join(root, "scripts/fake-agy.mjs")],
      env,
    }), profile.wireMode);
    t.after(async () => {
      await runtime.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });

    const events: StreamEvent[] = [];
    for await (const event of runtime.stream(model, { messages: [user("WIRE_TOOL_TEST")], tools: [read] }, {
      sessionId: `permission-${fixture.requested}`,
    }).stream) {
      events.push(event);
      if (event.type === "error") throw event.error;
    }
    const call = events.flatMap(event => event.type === "toolcall_end" ? [event.toolCall] : [])
      .find((candidate: ToolCall) => candidate.name === "read");
    assert.ok(call, "WIRE_TOOL_TEST must reach the real synthetic MCP read tool");
    const done = events.find(event => event.type === "done");
    assert.ok(done);
    assert.equal((done.message as AssistantMessage).stopReason, "toolUse");

    const snapshot = await runtime.snapshot();
    assert.equal(snapshot.permissionMode, fixture.expectedWireMode);
    assert.equal(snapshot.processes.length, 1);
    assert.equal(snapshot.processes[0]!.confirmedPermissionMode, fixture.expectedWireMode);
    assert.equal(snapshot.processes[0]!.mcpHttp, true, "CLI 1.5.3 MCP evidence must be normalized before tool projection");
    assert.deepEqual(snapshot.processes[0]!.omittedTools, []);

    const entries = fs.readFileSync(logFile, "utf8").trim().split("\n")
      .map(line => JSON.parse(line) as { event?: string; mode?: string; autoApproveMarker?: string });
    const start = entries.find(entry => entry.event === "start");
    assert.equal(start?.autoApproveMarker, fixture.autoApproveMarker);
    const modes = entries.filter(entry => entry.event === "mode");
    assert.ok(modes.length > 0);
    assert.equal(modes.at(-1)?.mode, fixture.expectedWireMode);
  });
}
