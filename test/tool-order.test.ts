import { test } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { stableTools } from "../extension/tool-order.ts";
import { OMP_TASK_TOOL_NAME, piToolFingerprint } from "../extension/runtime/tools/bridge.ts";
import { PERMISSION_TOOL_NAME } from "../extension/runtime/constants.ts";

type Schema = ReturnType<typeof Type.Object>;

interface TestTool {
  name: string;
  description: string;
  parameters: Schema;
}

const VALID_SCHEMA = Type.Object({ value: Type.String() });
const INVALID_SCHEMA = {
  type: "object", properties: { value: { type: "string" } }, unsupportedKeyword: true,
} as unknown as Schema;

const tool = (name: string, parameters: Schema = VALID_SCHEMA): TestTool => ({ name, description: `Tool ${name}`, parameters });
const task = (parameters: Schema = VALID_SCHEMA): TestTool => tool(OMP_TASK_TOOL_NAME, parameters);

interface Projection {
  names: string[];
  omissions: Array<{ name: string; reason: string }>;
}

function projection(tools: readonly TestTool[]): Projection {
  const parsed = JSON.parse(piToolFingerprint(tools)) as [Array<[string, string, unknown]>, Array<{ name: string; reason: string }>];
  return { names: parsed[0].map(([mcpName]) => mcpName), omissions: parsed[1] };
}

test("stableTools preserves OMP input order instead of alphabetizing", () => {
  const tools = [tool("write"), tool("read"), tool("bash"), tool("edit")];
  assert.deepEqual(stableTools(tools).map(item => item.name), ["write", "read", "bash", "edit"]);
});

test("the MCP projection keeps OMP input order", () => {
  const projected = projection([tool("write"), tool("read"), tool("bash")]);
  assert.deepEqual(projected.names, ["pi_write", "pi_read", "pi_bash"]);
  assert.deepEqual(projected.omissions, []);
});

test("a 70-tool list keeps task beyond the cap with the 63-plus-task rule", () => {
  const others = Array.from({ length: 69 }, (_, index) => tool(`other_${String(index).padStart(2, "0")}`));
  const tools = [...others, task()];
  const projected = projection(tools);
  assert.deepEqual(projected.names, [...others.slice(0, 63).map(item => `pi_${item.name}`), "pi_task"]);
  assert.deepEqual(projected.omissions.map(item => item.name), others.slice(63).map(item => item.name));
  assert.ok(projected.omissions.every(item => item.reason === "Tool limit 64 reached"));
});

test("task already inside the accepted prefix is not moved", () => {
  const others = Array.from({ length: 69 }, (_, index) => tool(`other_${String(index).padStart(2, "0")}`));
  const tools = [...others.slice(0, 10), task(), ...others.slice(10)];
  const projected = projection(tools);
  assert.deepEqual(projected.names, tools.slice(0, 64).map(item => `pi_${item.name}`));
  assert.equal(projected.names[10], "pi_task");
  assert.equal(projected.omissions.length, 6);
});

test("without task the ordinary first 64 tools are retained", () => {
  const tools = Array.from({ length: 70 }, (_, index) => tool(`other_${String(index).padStart(2, "0")}`));
  const projected = projection(tools);
  assert.deepEqual(projected.names, tools.slice(0, 64).map(item => `pi_${item.name}`));
  assert.deepEqual(projected.omissions.map(item => item.name), tools.slice(64).map(item => item.name));
});

test("an invalid task does not waste the reserved slot", () => {
  const others = Array.from({ length: 69 }, (_, index) => tool(`other_${String(index).padStart(2, "0")}`));
  const tools = [...others.slice(0, 5), task(INVALID_SCHEMA), ...others.slice(5)];
  const projected = projection(tools);
  const expected = others.slice(0, 64).map(item => `pi_${item.name}`);
  assert.deepEqual(projected.names, expected);
  assert.equal(projected.names.length, 64);
  assert.ok(!projected.names.includes("pi_task"));
  assert.match(projected.omissions.find(item => item.name === OMP_TASK_TOOL_NAME)?.reason ?? "", /schema omitted/);
  assert.deepEqual(projected.omissions.filter(item => item.reason === "Tool limit 64 reached").map(item => item.name),
    others.slice(64).map(item => item.name));
});

test("permission and whole-tool omissions keep their existing records and order", () => {
  const duplicate = tool("read");
  const projected = projection([
    tool("write"),
    { name: PERMISSION_TOOL_NAME, description: "permission", parameters: VALID_SCHEMA },
    tool("broken", INVALID_SCHEMA),
    duplicate,
    duplicate,
    tool("bash"),
  ]);
  assert.deepEqual(projected.names, ["pi_write", "pi_read", "pi_bash"]);
  assert.deepEqual(projected.omissions, [
    { name: "broken", reason: "schema omitted (unsupported_keyword)" },
    { name: "read", reason: "duplicate or invalid projected name" },
  ]);
});
