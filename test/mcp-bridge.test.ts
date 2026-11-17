import assert from "node:assert/strict";
import test from "node:test";
import type { Tool } from "@earendil-works/pi-ai";

import { fitToolsToBudget, PiMcpBridge } from "../extension/runtime/tools/bridge.ts";

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

test("tools/list entries carry the antigravity alwaysLoad meta", async () => {
  const metaTool = {
    name: "sourced",
    description: "Tool carrying upstream meta.",
    parameters: { type: "object", properties: {} },
    _meta: { source: "client" },
  } as unknown as Tool;
  const bridge = new PiMcpBridge({ tools: [tool, metaTool], onCall: async () => ({ content: [] }) });
  const server = await bridge.start();
  assert.ok(server);
  const authorization = server.headers?.find(header => header.name === "Authorization")?.value;
  assert.ok(authorization);
  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { authorization, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const events = text.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice("data: ".length));
    assert.ok(events.length > 0, "the bridge must answer tools/list with a data event");
    const body = JSON.parse(events[events.length - 1]!) as { result?: { tools?: Array<{ name?: string; _meta?: Record<string, unknown> }> } };
    const listed = body.result?.tools ?? [];
    assert.deepEqual(listed.map(entry => entry.name), ["omp_read", "omp_sourced"]);
    assert.deepEqual(listed[0]?._meta, { "antigravity/alwaysLoad": true });
    assert.deepEqual(listed[1]?._meta, { source: "client", "antigravity/alwaysLoad": true });
  } finally {
    await bridge.close();
  }
});

test("fitToolsToBudget shortens descriptions but keeps every tool and schema key", () => {
  const tools = Array.from({ length: 8 }, (_, index) => ({
    name: `tool_${index}`,
    description: "x".repeat(2000),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "p".repeat(2000), minLength: 1 },
        mode: { type: "string", enum: ["a", "b"] },
      },
      required: ["path"],
    },
  }));
  const budget = 1000;
  const fitted = fitToolsToBudget(tools, budget);
  assert.equal(fitted.length, tools.length, "no tool may be dropped");
  const tokens = fitted.reduce((total, entry) => total + Math.ceil(Buffer.byteLength(JSON.stringify(entry), "utf8") / 3), 0);
  assert.ok(tokens <= budget, `fitted listing takes ${tokens} tokens over budget ${budget}`);
  for (const [index, entry] of fitted.entries()) {
    assert.equal(entry.name, `tool_${index}`);
    assert.ok(entry.description !== undefined && entry.description.length < 2000, "the tool description must be shortened");
    const schema = entry.inputSchema as Record<string, unknown>;
    assert.deepEqual(Object.keys(schema.properties as object), ["path", "mode"]);
    assert.deepEqual(schema.required, ["path"]);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    assert.equal(properties.path!.type, "string");
    assert.equal(properties.path!.minLength, 1);
    assert.ok(typeof properties.path!.description === "string" && properties.path!.description.length < 2000);
    assert.deepEqual(properties.mode!.enum, ["a", "b"]);
  }
  // Purity: the caller's tools are never mutated.
  assert.equal(tools[0]!.description, "x".repeat(2000));
  const originalProperties = (tools[0]!.inputSchema as Record<string, Record<string, unknown>>).properties!;
  assert.equal(originalProperties.path!.description, "p".repeat(2000));
});

test("fitToolsToBudget returns an already-fitting list unchanged", () => {
  const tools = [{ name: "small", description: "Tiny.", inputSchema: { type: "object" } }];
  assert.equal(fitToolsToBudget(tools, 18000), tools);
});

async function listTools(server: { url: string; headers?: Array<{ name: string; value: string }> }): Promise<Array<{ name?: string; description?: string }>> {
  const authorization = server.headers?.find(header => header.name === "Authorization")?.value;
  assert.ok(authorization);
  const response = await fetch(server.url, {
    method: "POST",
    headers: { authorization, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  const events = text.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice("data: ".length));
  assert.ok(events.length > 0, "the bridge must answer tools/list with a data event");
  const body = JSON.parse(events[events.length - 1]!) as { result?: { tools?: Array<{ name?: string; description?: string }> } };
  return body.result?.tools ?? [];
}

test("repeated tools/list reuses the fitted listing and a tool update invalidates it", async () => {
  const bigTool = (name: string) => ({
    name,
    label: name,
    description: "x".repeat(3000),
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "p".repeat(3000) } },
    },
  }) as Tool;
  const tools = Array.from({ length: 10 }, (_, index) => bigTool(`tool_${index}`));
  const bridge = new PiMcpBridge({ tools, onCall: async () => ({ content: [] }) });
  const server = await bridge.start();
  assert.ok(server);
  try {
    const first = await listTools(server);
    const second = await listTools(server);
    assert.deepEqual(second, first, "an unchanged tool set must list identically");
    assert.equal(first.length, 10);
    for (const entry of first) {
      assert.ok(typeof entry.description === "string" && entry.description.length > 0 && entry.description.length < 3000,
        "the over-budget listing must carry shortened descriptions");
    }
    bridge.updateTools([...tools, bigTool("tool_10")]);
    const third = await listTools(server);
    assert.equal(third.length, 11, "a tool update must invalidate the fitted listing");
    assert.equal(third.at(-1)?.name, "omp_tool_10");
  } finally {
    await bridge.close();
  }
});
