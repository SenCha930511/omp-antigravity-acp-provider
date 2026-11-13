import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AntigravityAcpConnection } from "../extension/runtime/acp/connection.ts";

test("public session-list wrapper keeps the exact cwd and official response", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-acp-session-list-"));
  const connection = new AntigravityAcpConnection({
    cwd: process.cwd(),
    command: process.execPath,
    args: [path.join(process.cwd(), "scripts/fake-agy.mjs")],
    env: { ...process.env, FAKE_AGY_PROFILE: "cli-1.5.3", FAKE_AGY_SESSION_LIST: "1" },
    handlers: { onPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
  });
  t.after(async () => {
    await connection.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const initialize = await connection.initialize();
  assert.ok(initialize.agentCapabilities.sessionCapabilities?.list);

  const session = await connection.newSession(directory);
  const listed = await connection.listSessions(directory, new AbortController().signal);
  assert.deepEqual(listed.sessions, [{ sessionId: session.sessionId, cwd: directory }]);
  assert.equal(listed.sessions[0]?.sessionId, session.sessionId);
});
