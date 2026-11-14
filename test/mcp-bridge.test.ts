import assert from "node:assert/strict";
import test from "node:test";
import type { Tool } from "@earendil-works/pi-ai";

import { PiMcpBridge } from "../extension/runtime/tools/bridge.ts";

const tool = {
  name: "read",
  label: "Read",
  description: "Synthetic read tool.",
  parameters: { type: "object", properties: {} },
} as Tool;

test("malformed MCP JSON returns a JSON-RPC parse error instead of a generic 500", async () => {
  const bridge = new PiMcpBridge({ tools: [tool], onCall: async () => ({ content: [] }) });
  const server = await bridge.start();
  assert.ok(server);
  const authorization = server.headers?.find(header => header.name === "Authorization")?.value;
  assert.ok(authorization);
  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: "{",
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error?: { code?: number; message?: string } };
    assert.equal(body.error?.code, -32700);
    assert.equal(body.error?.message, "Parse error");
  } finally {
    await bridge.close();
  }
});
