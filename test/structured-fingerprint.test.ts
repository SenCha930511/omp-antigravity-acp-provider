import { test } from "node:test";
import assert from "node:assert/strict";
import { createStructuredFingerprintMemo } from "../extension/runtime/binding.ts";
import { AntigravityRuntime, Type } from "../extension/runtime.mjs";

test("structured snapshots reuse equivalent containers and detect deep schema/descriptor changes", () => {
  const memo = createStructuredFingerprintMemo(); let calls = 0;
  const schema: any = Type.Object({ path: Type.String({ description: "file" }) });
  const tool = () => ({ name: "read", parameters: schema, execute: async () => {} });
  const run = () => memo([tool()], () => String(++calls));
  assert.equal(run(), "1"); assert.equal(run(), "1");
  schema.properties.path.description = "edited";
  assert.equal(run(), "2");
  Object.defineProperty(schema, "hidden", { configurable: true, enumerable: false, value: 42 });
  assert.equal(run(), "3"); delete schema.hidden;
  assert.equal(run(), "4"); memo.clear(); assert.equal(run(), "5");
});

test("unsupported shapes and oversized snapshots never reuse a stale result", () => {
  for (const value of [new Proxy({}, {}), { get text() { return "getter"; } }, new Date(),
    Object.assign([], { map: () => [] }), { huge: "x".repeat(2 * 1024 * 1024 + 1) },
    Object.fromEntries(Array.from({ length: 32769 }, (_, i) => [String(i), i])),
    { [Symbol("schema")]: true }]) {
    const memo = createStructuredFingerprintMemo(); let calls = 0;
    memo(value, () => String(++calls)); memo(value, () => String(++calls));
    assert.equal(calls, 2);
  }
  const memo = createStructuredFingerprintMemo(); let calls = 0;
  const fn: any = () => {};
  const run = () => memo({ fn }, () => String(++calls));
  run(); assert.equal(run(), "1"); fn.toJSON = () => "changed";
  assert.equal(run(), "2"); assert.equal(run(), "3");
});

test("built runtime owns independent system/tool caches and preserves exact baseline fingerprints", async () => {
  const runtime: any = new AntigravityRuntime(() => {}, "yolo");
  const tools: any[] = [{ name: "read", description: "read", parameters: Type.Object({ path: Type.String() }) }];
  const system = () => ({ role: "system", content: "rules", toolsAdded: tools });
  const initial = runtime.ompMessageFingerprint(system());
  assert.equal(runtime.ompMessageFingerprint(system()), initial);
  const fingerprint = runtime.ompToolsFingerprint(tools);
  tools[0].parameters.properties.path.description = "new field description";
  assert.notEqual(runtime.ompToolsFingerprint([...tools]), fingerprint);
  assert.notEqual(runtime.ompMessageFingerprint(system()), initial);
  await runtime.close();
  let calls = 0;
  runtime.ompSystemMemo({}, () => String(++calls));
  await runtime.closeBindings();
  runtime.ompSystemMemo({}, () => String(++calls));
  assert.equal(calls, 2, "Shutdown releases the retained structured snapshot");
});
