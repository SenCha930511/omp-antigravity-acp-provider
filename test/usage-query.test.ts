import { test } from "node:test";
import assert from "node:assert/strict";
import { TierConnection } from "../extension/tier-connection.ts";

test("promptWithoutUsageDeltas bypasses supplemental usage accounting and prompt tracking", async () => {
  const connection = new TierConnection({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    handlers: {},
  });
  let calls = 0;
  Object.defineProperty(connection, "connection", { value: {
    prompt: async () => {
      calls++;
      return { stopReason: "end_turn" };
    },
  } });
  try {
    await connection.promptWithoutUsageDeltas({ sessionId: "session", prompt: [{ type: "text", text: "/usage" }] });
    assert.equal(calls, 1);
    assert.equal(connection.usageQueryCount, 0);
    assert.equal(connection.activePrompts, 0);
  } finally {
    await connection.close();
  }
});

test("concurrent /usage reads coalesce while a later read starts fresh", async () => {
  const connection: any = new TierConnection({
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    handlers: {},
  });
  let calls = 0;
  connection.connection = {
    prompt: async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { stopReason: "end_turn" };
    },
  };
  try {
    const [first, second] = await Promise.all([
      connection.readUsage("session"),
      connection.readUsage("session"),
    ]);
    assert.equal(first, undefined);
    assert.equal(second, undefined);
    assert.equal(calls, 1, "a second caller must share the inflight read");
    await connection.readUsage("session");
    assert.equal(calls, 2, "a read after settlement must query again");
  } finally {
    await connection.close();
  }
});
