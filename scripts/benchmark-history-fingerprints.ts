// Read-only local CPU benchmark. Synthetic history only; no models or files of user data.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "extension/vendor/pi-antigravity-acp-provider/src/runtime.ts"), "utf8");
const start = source.indexOf("function messagesFingerprint(");
const end = source.indexOf("function findToolResult(", start);
assert.ok(start > 0 && end > start);
const code = transformSync(source.slice(start, end), { loader: "ts", target: "node22" }).code;
const baseline = Function("createHash", code + ";return { messagesFingerprint, messageFingerprint };")(createHash);

function payload(m: any) {
  if (m.role === "user") return { role: m.role, content: m.content };
  if (m.role === "assistant") return { role: m.role, provider: m.provider, model: m.model, content: m.content };
  if (m.role === "system") return { role: m.role, content: m.content, sections: m.sections, toolsAdded: m.toolsAdded, toolsRemoved: m.toolsRemoved };
  return { role: m.role, toolCallId: m.toolCallId, toolName: m.toolName, content: m.content, isError: m.isError };
}
function canonicalWrite(value: any, write: (s: string) => void) {
  if (Array.isArray(value)) {
    write("["); for (let i = 0; i < value.length; i++) { if (i) write(","); canonicalWrite(value[i], write); } write("]");
  } else if (value && typeof value === "object") {
    write("{"); let first = true;
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
    for (const [key, child] of entries) {
      if (!first) write(","); first = false; write(JSON.stringify(key)); write(":"); canonicalWrite(child, write);
    }
    write("}");
  } else write(JSON.stringify(value) ?? "null");
}
function streamingMessage(m: any, buffered: boolean) {
  const hash = createHash("sha256"); let buffer = "";
  const flush = () => { if (buffer) { hash.update(buffer); buffer = ""; } };
  canonicalWrite(payload(m), s => {
    if (!buffered) hash.update(s);
    else if (s.length >= 8192) { flush(); hash.update(s); }
    else { buffer += s; if (buffer.length >= 8192) flush(); }
  });
  flush(); return hash.digest("hex");
}
function range(messages: any[], count: number, fingerprint: (m: any) => string) {
  const hash = createHash("sha256");
  for (let i = 0; i < count; i++) { if (i) hash.update("\n"); hash.update(fingerprint(messages[i])); }
  return hash.digest("hex");
}
// Research prototype: validate every live field against an independent value
// snapshot. Never treat a matching object reference as proof of no mutation.
const memo = new WeakMap<object, { value: any; digest: string }>();
function same(value: any, saved: any): boolean {
  if (value === null || typeof value !== "object") return Object.is(value, saved);
  if (saved === null || typeof saved !== "object" || Array.isArray(value) !== Array.isArray(saved)) return false;
  const keys = Object.keys(value), oldKeys = Object.keys(saved);
  if (keys.length !== oldKeys.length || (Array.isArray(value) && value.length !== saved.length)) return false;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (descriptor.get || descriptor.set || !Object.hasOwn(saved, key) || !same(descriptor.value, saved[key])) return false;
  }
  return true;
}
function copy(value: any): any {
  if (!value || typeof value !== "object") return value;
  return Array.isArray(value) ? value.map(copy) : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copy(child)]));
}
function eligible(value: any, budget = { nodes: 0, large: false }, seen = new Set<any>()): boolean {
  if (++budget.nodes > 128) return false;
  if (typeof value === "string") { budget.large ||= value.length >= 2048; return true; }
  if (value === null || typeof value !== "object") return typeof value !== "function" && typeof value !== "symbol" && typeof value !== "bigint";
  if (seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) return false;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue;
    if (descriptor.get || descriptor.set || !eligible(descriptor.value, budget, seen)) return false;
  }
  return true;
}
function verifiedMemoMessage(message: any) {
  const content = message.content;
  const worthCaching = typeof content === "string" ? content.length >= 2048 : Array.isArray(content) && content.some(block =>
    [block?.text, block?.data, block?.thinking].some(value => typeof value === "string" && value.length >= 2048));
  if (!worthCaching) { memo.delete(message); return baseline.messageFingerprint(message); }
  const value = payload(message), prior = memo.get(message);
  if (prior && same(value, prior.value)) return prior.digest;
  const digest = baseline.messageFingerprint(message), budget = { nodes: 0, large: false };
  if (eligible(value, budget) && budget.large) memo.set(message, { value: copy(value), digest });
  else memo.delete(message);
  return digest;
}
function fixture(bytes: number, structured = false) {
  const messages: any[] = [{ role: "system", content: "STATIC RULES", toolsAdded: [{ name: "read", parameters: { type: "object" } }] }];
  const count = structured ? 400 : 100;
  for (let i = 0; i < count; i++) messages.push(i % 2
    ? { role: "assistant", model: "gemini-3.8-flash", provider: "antigravity-acp", content: [{ type: "toolCall", id: `call-${i}`, name: "read", arguments: structured
      ? Object.fromEntries(Array.from({ length: 30 }, (_, j) => [`field-${j}`, { text: "中英文\n\"\\𠮷".repeat(8), values: [null, true, 42, undefined] }])) : { path: "fixture.txt" } }] }
    : { role: "toolResult", toolCallId: `call-${i-1}`, toolName: "read", content: [{ type: "text", text: "參考 text line\n".repeat(Math.ceil(bytes / (count / 2) / 20)) }], isError: false });
  messages.push({ role: "user", content: "CURRENT" }); return messages;
}
const candidates = {
  baseline: (ms: any[], n: number) => baseline.messagesFingerprint(ms.slice(0, n)),
  rangeOnly: (ms: any[], n: number) => range(ms, n, baseline.messageFingerprint),
  directStreaming: (ms: any[], n: number) => range(ms, n, m => streamingMessage(m, false)),
  bufferedStreaming: (ms: any[], n: number) => range(ms, n, m => streamingMessage(m, true)),
  verifiedMemo: (ms: any[], n: number) => range(ms, n, verifiedMemoMessage),
};
// Safety probes use the same mutable object repeatedly: no identity-only hit.
const mutable: any = { role: "toolResult", toolCallId: "call", toolName: "read", isError: false,
  content: [{ type: "text", text: "LONG_REFERENCE".repeat(200), args: { values: [1, 2], flag: true } }] };
for (const edit of [() => {}, () => { mutable.isError = true; }, () => { mutable.toolCallId = "changed"; },
  () => { mutable.content[0].args.values.reverse(); }, () => { delete mutable.content[0].args.flag; },
  () => { mutable.content.push({ type: "text", text: "NEW" }); }, () => { mutable.content[0].text = "EDITED".repeat(400); }]) {
  edit(); assert.equal(verifiedMemoMessage(mutable), baseline.messageFingerprint(mutable));
}
for (const messages of [fixture(128_000), fixture(1_048_576), fixture(8_388_608), fixture(128_000, true)]) {
  const count = messages.length - 1;
  const expected = candidates.baseline(messages, count);
  for (const fn of Object.values(candidates)) assert.equal(fn(messages, count), expected, "Candidates must preserve the exact existing SHA-256 digest");
  const before = expected;
  messages[2].content[0].arguments.path = "EDITED_IN_PLACE";
  const after = candidates.baseline(messages, count); assert.notEqual(after, before);
  for (const fn of Object.values(candidates)) assert.equal(fn(messages, count), after, "In-place edits must not bypass validation");
  const textMessage = messages[1]; const priorText = textMessage.content[0].text;
  textMessage.content[0].text = "EDITED_TEXT";
  assert.equal(candidates.verifiedMemo(messages, count), candidates.baseline(messages, count), "In-place text edits must invalidate a cached digest");
  textMessage.content[0].text = priorText;
  const rows: Record<string, number[]> = Object.fromEntries(Object.keys(candidates).map(k => [k, []]));
  const names = Object.keys(candidates) as Array<keyof typeof candidates>;
  for (const fn of Object.values(candidates)) for (let warmup = 0; warmup < 10; warmup++) fn(messages, count);
  for (let sample = 0; sample < 9; sample++) for (let j = 0; j < names.length; j++) {
    const name = names[(sample + j) % names.length]; const begin = performance.now();
    for (let repeat = 0; repeat < 3; repeat++) candidates[name](messages, count);
    rows[name].push((performance.now() - begin) / 3);
  }
  const results = Object.fromEntries(Object.entries(rows).map(([name, ms]) => {
    ms.sort((a, b) => a - b); return [name, { medianMs: +ms[4].toFixed(3), p95Ms: +ms[8].toFixed(3) }];
  }));
  console.log(JSON.stringify({ node: process.version, bun: process.versions.bun ?? null,
    jsonBytes: Buffer.byteLength(JSON.stringify(messages)), messages: count, samples: 9, results }));
  const cold: Record<string, number[]> = { baseline: [], verifiedMemo: [] };
  for (let sample = 0; sample < 9; sample++) for (const name of (sample % 2 ? ["verifiedMemo", "baseline"] : ["baseline", "verifiedMemo"]) as Array<keyof typeof cold>) {
    const cloned = structuredClone(messages); // Outside timing; simulate a host rebuilding objects.
    const begin = performance.now(); candidates[name](cloned, count); cold[name].push(performance.now() - begin);
  }
  console.log(JSON.stringify({ coldNewObjects: true, jsonBytes: Buffer.byteLength(JSON.stringify(messages)),
    medianMs: Object.fromEntries(Object.entries(cold).map(([k, v]) => [k, +v.sort((a, b) => a - b)[4].toFixed(3)])) }));
}
