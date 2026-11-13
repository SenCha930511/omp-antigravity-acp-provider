import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createHistoryFingerprintMemo } from "../extension/runtime/binding.ts";
import { AntigravityRuntime, Type } from "../extension/runtime.mjs";

// Execute the fingerprint functions from the actual generated runtime, including
// its guarded build seam, rather than testing a second copy of the algorithm.
const source = fs.readFileSync("extension/runtime.mjs", "utf8");
const start = source.indexOf("function messagesFingerprint(");
const end = source.indexOf("function findToolResult(", start);
assert.ok(start > 0 && end > start);
const code = source.slice(start, end).replace(/\bcreateHash\d*\b/g, "createHash");
assert.ok(code.includes("ompMessageFingerprintMemo(message, value"));
const load = (memo: any) => Function("createHash", "ompMessageFingerprintMemo", code +
  ";return { messagesFingerprint, messageFingerprint };")(createHash, memo);
const baseline = load((_message: any, _value: any, compute: () => string) => compute());
const optimized = load(createHistoryFingerprintMemo());
const long = "中英文\n𠮷".repeat(1000);

test("per-runtime system/tool memo matches original digests through TypeBox and in-place schema edits", async () => {
  const runtime: any = new AntigravityRuntime(() => {}, "yolo");
  const tools: any[] = [{ name: "read", description: "read", execute: async () => {},
    parameters: Type.Object({ path: Type.String() }) }];
  const system: any = { role: "system", content: long, toolsAdded: tools };
  const check = () => {
    assert.equal(runtime.ompMessageFingerprint({ ...system }), baseline.messageFingerprint(system));
    const cached = runtime.ompToolsFingerprint([...tools]);
    const memo = runtime.ompToolsMemo;
    try {
      runtime.ompToolsMemo = (_value: any, compute: () => string) => compute();
      assert.equal(cached, runtime.ompToolsFingerprint(tools));
    } finally { runtime.ompToolsMemo = memo; }
  };
  for (const edit of [() => {}, () => {}, () => { tools[0].parameters.properties.path.description = "edited"; },
    () => { tools[0].parameters.required = []; }, () => { tools[0].description = "new description"; },
    () => { system.sections = { policy: "new rules" }; },
    () => { Object.defineProperty(tools[0].parameters, "hidden", { configurable: true, enumerable: false, value: 1 }); },
    () => { delete tools[0].parameters.hidden; tools[0].parameters[Symbol.for("fixture")] = true; },
    () => { delete tools[0].parameters[Symbol.for("fixture")]; tools[0].execute = async () => {}; }]) { edit(); check(); }
  await runtime.close();
});

test("built runtime preserves exact digests after nested historical mutations", () => {
  const messages: any[] = [
    { role: "system", content: long, sections: [{ name: "rules" }], toolsAdded: ["read"] },
    { role: "user", content: [{ type: "text", text: long }] },
    { role: "assistant", provider: "acp", model: "flash", content: [{ type: "thinking", thinking: long },
      { type: "toolCall", id: "call", name: "read", arguments: { values: [1, 2], optional: undefined } }] },
    { role: "toolResult", toolCallId: "call", toolName: "read", isError: false, content: [{ type: "text", text: long }] },
  ];
  const check = () => assert.equal(optimized.messagesFingerprint(messages), baseline.messagesFingerprint(messages));
  for (const edit of [() => {}, () => {}, () => { messages[0].sections[0].name = "edited"; },
    () => { messages[0].toolsRemoved = ["read"]; }, () => { messages[1].content[0].text += "edit"; },
    () => { messages[2].model = "changed"; }, () => { messages[2].provider = "changed"; },
    () => { messages[2].content[1].arguments.values.reverse(); },
    () => { delete messages[2].content[1].arguments.optional; },
    () => { messages[2].content.push({ type: "text", text: "partial" }); },
    () => { messages[3].toolCallId = "other"; }, () => { messages[3].isError = true; },
    () => { messages[3].content[0].text = "small"; },
    () => { messages[1].role = "assistant"; }, () => { messages.reverse(); }]) { edit(); check(); }
  check();
  assert.equal(optimized.messagesFingerprint(structuredClone(messages)), baseline.messagesFingerprint(messages));
});

test("memo validates before reuse, ignores unselected metadata, and skips small payloads", () => {
  const memo = createHistoryFingerprintMemo();
  const message: any = { role: "user", content: long };
  let calls = 0;
  const digest = () => memo(message, { role: message.role, content: message.content }, () => String(++calls));
  assert.equal(digest(), "1");
  message.timestamp = 3;
  assert.equal(digest(), "1");
  message.content += "new";
  assert.equal(digest(), "2");
  message.content = "small";
  assert.equal(digest(), "3");
  assert.equal(digest(), "4");
});

test("unsupported or changed shapes fall back without stale hashes", () => {
  const message: any = { role: "user", content: [{ type: "text", text: long }] };
  const check = () => assert.equal(optimized.messageFingerprint(message), baseline.messageFingerprint(message));
  check();
  Object.defineProperty(message.content, "map", { configurable: true, value: () => ["custom-map"] });
  check();
  delete message.content.map;
  delete message.content[0]; // sparse array uses the upstream empty-segment encoding
  check();
  message.content = [{ type: "text", text: long, nested: new Date(0) }]; check();
  message.content[0].nested = new Proxy({ text: "value" }, {}); check();
  message.content[0].nested = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [i, i])); check();
  message.content = [{ type: "text", text: long }]; check();
  Object.setPrototypeOf(message.content[0], { inherited: true }); check();
  Object.defineProperty(message.content[0], "text", { enumerable: true, get: () => long + "getter" }); check();
});
