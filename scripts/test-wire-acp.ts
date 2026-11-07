import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TierConnection } from "../extension/runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const updates: any[] = [];
const permissions: any[] = [];
const connection: any = new TierConnection({
  cwd: root,
  command: process.execPath,
  args: [path.join(root, "scripts/fake-agy.mjs")],
  handlers: {
    onUpdate: async (notification: any) => { updates.push(notification); },
    onPermission: async (request: any) => {
      permissions.push(request);
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    },
  },
});

const textOf = (notification: any) => notification.update.sessionUpdate === "agent_message_chunk"
  ? notification.update.content?.text ?? ""
  : undefined;

try {
  await connection.initialize();
  const session = await connection.newSession(root);
  const sessionId = session.sessionId;

  updates.length = 0;
  const noticed = await connection.prompt({ sessionId, prompt: [{ type: "text", text: "NOTICE_TEST" }] });
  assert.equal(noticed.stopReason, "end_turn");
  assert.deepEqual(updates.map(textOf).filter(Boolean), ["VISIBLE"], "notices must not reach the transcript");

  updates.length = 0;
  const permitted = await connection.prompt({ sessionId, prompt: [{ type: "text", text: "PERMISSION_TEST" }] });
  assert.equal(permitted.stopReason, "end_turn");
  assert.equal(permissions.length, 1);
  assert.equal(permissions[0].toolCall.title, "Forged title: read /secret");
  assert.deepEqual(permissions[0].toolCall.rawInput, { path: "/secret", tool: "read" });
  assert.ok(updates.map(textOf).includes("PERMISSION:selected:allow_once"));

  updates.length = 0;
  const continued = await connection.prompt({ sessionId, prompt: [{ type: "text", text: "MAX_TOKENS_TEST" }] });
  assert.equal(continued.stopReason, "end_turn");
  assert.deepEqual(updates.map(textOf).filter(Boolean), ["PARTIAL", "CONTINUED"]);

  updates.length = 0;
  const used = await connection.prompt({ sessionId, prompt: [{ type: "text", text: "USAGE_TEST" }] });
  assert.deepEqual(used.usage, { inputTokens: 10, outputTokens: 2 });
  assert.ok(updates.map(textOf).includes("FAKE_OK"));

  console.log("Wire ACP notices, permission forwarding, continuation and usage: PASS");
} finally {
  await connection.close();
}
