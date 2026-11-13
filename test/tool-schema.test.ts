import { test } from "node:test";
import assert from "node:assert/strict";
import { projectToolSchema } from "../extension/runtime/tools/schema.ts";
import { relayControlTool } from "../extension/runtime/tools/relay.ts";
import { PiMcpBridge } from "../extension/runtime/tools/bridge.ts";
import type { Tool } from "@earendil-works/pi-ai";

test("TypeBox relay schema stays visible in the projected bridge catalog", () => {
  const response = projectToolSchema(relayControlTool.parameters);
  if ("reason" in response) assert.fail(`relay schema was omitted (${response.reason})`);
  assert.deepEqual(response.schema, {
    type: "object",
    required: ["call_id"],
    properties: { call_id: { type: "string", minLength: 1 } },
  });
  const tools: Tool[] = [
    { ...relayControlTool, execute: async () => ({ content: [{ type: "text" as const, text: "fixture" }] }) },
  ];
  const bridge = new PiMcpBridge({ tools, onCall: async () => ({ content: [{ type: "text" as const, text: "fixture" }] }) });
  assert.equal(bridge.empty, false, "the relay catalog must not be empty after TypeBox projection");
  assert.deepEqual(bridge.omissions, []);
});

test("nullable property types project to the string type downstream consumers accept", () => {
  const parameters = {
    type: "object",
    properties: { skip: { type: ["number", "null"] } },
    required: ["skip"],
  };
  const projected = projectToolSchema(parameters);
  if (!("schema" in projected)) assert.fail(`schema omitted (${projected.reason})`);
  const properties: unknown = projected.schema.properties;
  assert.ok(properties !== null && typeof properties === "object" && !Array.isArray(properties), "properties must be an object");
  assert.ok("skip" in properties, "skip must be projected");
  const skip = properties.skip;
  assert.ok(skip !== null && typeof skip === "object" && !Array.isArray(skip), "skip must be a schema object");
  assert.ok("type" in skip, "skip must keep a type");
  assert.equal(skip.type, "number");
  assert.doesNotMatch(JSON.stringify(projected.schema), /"type":\s*\[/);
});

test("type unions preserve existing combinators and use string leaf types", () => {
  const members = [
    { type: "number", minimum: 0 },
    { type: "string", maxLength: 4 },
  ];
  const projected = projectToolSchema({
    type: "object",
    properties: { choice: { anyOf: members, type: ["number", "string"] } },
  });
  if (!("schema" in projected)) assert.fail(`schema omitted (${projected.reason})`);
  const properties: unknown = projected.schema.properties;
  assert.ok(properties !== null && typeof properties === "object" && !Array.isArray(properties));
  assert.ok("choice" in properties, "choice must be projected");
  const choice = properties.choice;
  assert.ok(choice !== null && typeof choice === "object" && !Array.isArray(choice), "choice must be a schema object");
  assert.deepEqual(choice.anyOf, members);
  assert.deepEqual(choice.allOf, [{ anyOf: [{ type: "number" }, { type: "string" }] }]);
  assert.doesNotMatch(JSON.stringify(projected.schema), /"type":\s*\[/);
});
