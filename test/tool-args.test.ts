import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectToolArguments, normalizeToolArguments, renderToolSignature } from "../extension/tool-args.ts";

const FILE_SCHEMA = {
  type: "object",
  properties: {
    file_path: { type: "string" },
    description: { type: "string" },
  },
  required: ["file_path"],
};

test("renames an alias only in the fully unambiguous case", () => {
  const { arguments: args, renamed } = normalizeToolArguments(FILE_SCHEMA, { path: "/tmp/a.ts", description: "read" });
  assert.deepEqual(renamed, [{ from: "path", to: "file_path" }]);
  assert.deepEqual(args, { file_path: "/tmp/a.ts", description: "read" });
});

test("no rename when the target key is already present", () => {
  const { arguments: args, renamed } = normalizeToolArguments(FILE_SCHEMA, { file_path: "/a", path: "/b" });
  assert.deepEqual(renamed, []);
  assert.deepEqual(args, { file_path: "/a", path: "/b" });
});

test("no rename when the schema declares two members of one group", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string" },
      file_path: { type: "string" },
    },
    required: ["file_path"],
  };
  const { arguments: args, renamed } = normalizeToolArguments(schema, { absolute_path: "/a" });
  assert.deepEqual(renamed, []);
  assert.deepEqual(args, { absolute_path: "/a" });
});

test("no rename when the input carries two members of one group", () => {
  const { arguments: args, renamed } = normalizeToolArguments(FILE_SCHEMA, { path: "/a", absolute_path: "/b" });
  assert.deepEqual(renamed, []);
  assert.deepEqual(args, { path: "/a", absolute_path: "/b" });
});

test("no rename when the schema property is not a string field", () => {
  const schema = {
    type: "object",
    properties: { file_path: { type: "number" } },
    required: ["file_path"],
  };
  const { arguments: args, renamed } = normalizeToolArguments(schema, { path: "/a" });
  assert.deepEqual(renamed, []);
  assert.deepEqual(args, { path: "/a" });
});

test("no rename when the input value is not a string", () => {
  const { arguments: args, renamed } = normalizeToolArguments(FILE_SCHEMA, { path: 42 });
  assert.deepEqual(renamed, []);
  assert.deepEqual(args, { path: 42 });
});

test("no rename when the schema lacks the group target", () => {
  const schema = { type: "object", properties: { contents: { type: "string" } } };
  const { arguments: args, renamed } = normalizeToolArguments(schema, { path: "/a" });
  assert.deepEqual(renamed, []);
  assert.deepEqual(args, { path: "/a" });
});

test("missing or non-object schema and non-object args are no-ops", () => {
  assert.deepEqual(normalizeToolArguments(undefined, { path: "/a" }), { arguments: { path: "/a" }, renamed: [] });
  assert.deepEqual(normalizeToolArguments("not a schema", { path: "/a" }), { arguments: { path: "/a" }, renamed: [] });
  assert.deepEqual(normalizeToolArguments(FILE_SCHEMA, null), { arguments: null, renamed: [] });
});

test("reports required keys that are absent or explicitly undefined", () => {
  const schema = {
    type: "object",
    properties: {
      file_path: { type: "string" },
      description: { type: "string" },
    },
    required: ["file_path", "description"],
  };
  assert.deepEqual(inspectToolArguments(schema, { description: "d" }).missing, ["file_path"]);
  assert.deepEqual(inspectToolArguments(schema, { file_path: undefined, description: "d" }).missing, ["file_path"]);
  assert.deepEqual(inspectToolArguments(schema, { file_path: "/a", description: "d" }).missing, []);
});

test("inspection is never stricter than schema validation", () => {
  const schema = {
    type: "object",
    properties: { file_path: { type: "string" } },
    required: ["file_path"],
  };
  assert.deepEqual(inspectToolArguments(schema, { file_path: 42, surprise: true }).missing, []);
  assert.deepEqual(inspectToolArguments(undefined, { file_path: "/a" }).missing, []);
  assert.deepEqual(inspectToolArguments(schema, undefined).missing, ["file_path"]);
});

test("renders required parameters first, then optional ones in declaration order", () => {
  const schema = {
    type: "object",
    properties: {
      offset: { type: "number" },
      file_path: { type: "string" },
      limit: { type: "number" },
      dry: { type: "boolean" },
    },
    required: ["file_path", "offset"],
  };
  assert.equal(
    renderToolSignature("pi_read", schema),
    "pi_read(file_path: string, offset: number, limit?: number, dry?: boolean)",
  );
});

test("renders enums capped at six values", () => {
  const schema = {
    type: "object",
    properties: { mode: { enum: ["a", "b", "c", "d", "e", "f", "g"] } },
    required: ["mode"],
  };
  assert.equal(renderToolSignature("pi_set", schema), "pi_set(mode: a|b|c|d|e|f|...)");
  const short = { type: "object", properties: { mode: { enum: ["read", "write"] } }, required: ["mode"] };
  assert.equal(renderToolSignature("pi_set", short), "pi_set(mode: read|write)");
});

test("renders arrays and unions, degrading past the depth cap", () => {
  const schema = {
    type: "object",
    properties: {
      lines: { type: "array", items: { type: "string" } },
      target: { anyOf: [{ type: "string" }, { type: "number" }] },
      nested: { type: "array", items: { type: "array", items: { anyOf: [{ type: "string" }] } } },
      wide: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }, { type: "object" }] },
      blob: { type: "object", additionalProperties: true },
    },
  };
  assert.equal(
    renderToolSignature("pi_x", schema),
    "pi_x(lines?: string[], target?: string|number, nested?: any[][], wide?: string|number|boolean|null, blob?: any)",
  );
});

test("tolerates an undefined schema", () => {
  assert.equal(renderToolSignature("pi_x", undefined), "pi_x()");
  assert.equal(renderToolSignature("pi_x", { type: "object", required: ["file_path"] }), "pi_x(file_path: any)");
});
