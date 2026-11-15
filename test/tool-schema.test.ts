import { test } from "node:test";
import assert from "node:assert/strict";
import { projectToolSchema } from "../extension/runtime/tools/schema.ts";
import { relayControlTool } from "../extension/runtime/tools/relay.ts";
import { PiMcpBridge } from "../extension/runtime/tools/bridge.ts";
import { Value } from "typebox/value";
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

test("nullable property types preserve null with string leaf types", () => {
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
  assert.deepEqual(skip, { anyOf: [{ type: "number" }, { type: "null" }] });
  assert.equal(Value.Check(parameters, { skip: null }), true, "the original MCP schema must accept null too");
  assert.equal(Value.Check(parameters, { skip: 0 }), true);
  assert.equal(Value.Check(parameters, { skip: "0" }), false);
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

test("RE2-unsafe patterns drop the pattern field and become description hints", () => {
  const projected = projectToolSchema({
    type: "object",
    properties: {
      lookahead: { type: "string", description: "An identifier.", pattern: "a(?=b)" },
      negative: { type: "string", pattern: "x(?!y)" },
      lookbehind: { type: "string", pattern: "(?<=a)b" },
      backref: { type: "string", pattern: "(a)\\1" },
      quotemeta: { type: "string", pattern: "\\Qa.b\\E" },
      reinterpreted: { type: "string", pattern: "a\\z|\\A|\\a|\\K" },
    },
  });
  if (!("schema" in projected)) assert.fail(`schema omitted (${projected.reason})`);
  const properties = projected.schema.properties as Record<string, Record<string, unknown>>;
  for (const name of ["lookahead", "negative", "lookbehind", "backref", "quotemeta", "reinterpreted"]) {
    const node = properties[name]!;
    assert.equal("pattern" in node, false, `${name} must lose the pattern field`);
    assert.ok(typeof node.description === "string" && node.description.includes("pattern: "), `${name} must carry the hint`);
  }
  assert.equal(properties.lookahead!.description, "An identifier. (pattern: a(?=b))");
  assert.equal(properties.negative!.description, "pattern: x(?!y)");
});

test("RE2-safe patterns are preserved and unicode escapes translate to code point escapes", () => {
  const projected = projectToolSchema({
    type: "object",
    properties: {
      plain: { type: "string", pattern: "^[a-z]\\d{2,4}$" },
      acute: { type: "string", pattern: "\\u00e9+" },
      braced: { type: "string", pattern: "\\u{1F600}" },
      surrogatePair: { type: "string", pattern: "^\\ud83d\\ude00$" },
      literalBackslash: { type: "string", pattern: "\\\\u00e9" },
      namedGroup: { type: "string", pattern: "(?<year>\\d{4})" },
    },
  });
  if (!("schema" in projected)) assert.fail(`schema omitted (${projected.reason})`);
  const properties = projected.schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.plain!.pattern, "^[a-z]\\d{2,4}$");
  assert.equal(properties.acute!.pattern, "\\x{00E9}+");
  assert.equal(properties.braced!.pattern, "\\x{1F600}");
  assert.equal(properties.surrogatePair!.pattern, "^\\x{1F600}$");
  assert.equal(properties.literalBackslash!.pattern, "\\\\u00e9");
  assert.equal(properties.namedGroup!.pattern, "(?<year>\\d{4})");
  for (const name of Object.keys(properties)) {
    assert.equal("description" in properties[name]!, false, `${name} must stay hint-free`);
  }
});

test("pattern projection is idempotent", () => {
  const schema = {
    type: "object",
    properties: {
      hinted: { type: "string", description: "Existing.", pattern: "a(?=b)" },
      translated: { type: "string", pattern: "\\u00e9\\u{1F600}" },
      kept: { type: "string", pattern: "^[a-z]\\d{2,4}$" },
    },
  };
  const once = projectToolSchema(schema);
  if (!("schema" in once)) assert.fail(`schema omitted (${once.reason})`);
  const twice = projectToolSchema(once.schema);
  if (!("schema" in twice)) assert.fail(`schema omitted (${twice.reason})`);
  assert.deepEqual(twice.schema, once.schema);
});

test("named backreferences and unknown identity escapes drop to hints", () => {
  const named = projectToolSchema(patternSchema("(?<word>a)\\k<word>"));
  assert.ok("reason" in named === false, "the tool must stay listed");
  const hint = descriptionOf(named);
  assert.equal(hint, "pattern: (?<word>a)\\k<word>");
  assert.equal(patternOf(named), undefined);

  const identity = projectToolSchema(patternSchema("a\\eb"));
  assert.equal(descriptionOf(identity), "pattern: a\\eb");
  assert.equal(patternOf(identity), undefined);
});

function descriptionOf(projected: { schema: { properties?: { value?: { description?: string } } } }): string {
  return projected.schema.properties?.value?.description ?? "";
}

function patternOf(projected: { schema: { properties?: { value?: { pattern?: string } } } }): string | undefined {
  return projected.schema.properties?.value?.pattern;
}

function patternSchema(pattern: string): unknown {
  return { type: "object", properties: { value: { type: "string", pattern } }, required: ["value"] };
}
