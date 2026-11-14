// Offline synthetic benchmark of the exact fingerprint functions in the bundle.
import fs from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate as immediate } from "node:timers/promises";
import { createHistoryFingerprintMemo } from "../extension/runtime/binding.ts";

const source = fs.readFileSync("extension/runtime.mjs", "utf8");
const start = source.indexOf("function messagesFingerprint(");
const end = source.indexOf("function findToolResult(", start);
assert.ok(start > 0 && end > start);
const code = source.slice(start, end).replace(/\bcreateHash\d*\b/g, "createHash");
assert.ok(code.includes("ompMessageFingerprintMemo(message, value"));
function load(memo: any) {
  return Function("createHash", "ompMessageFingerprintMemo", code + ";return messagesFingerprint;")(createHash, memo);
}
const baseline = load((_message: any, _value: any, compute: () => string) => compute());
const optimized = load(createHistoryFingerprintMemo());
function fixture(chars: number, count = 100, complex = false): any[] {
  return Array.from({ length: count }, (_, i) => ({ role: "toolResult", toolCallId: String(i), toolName: "read",
    content: [{ type: "text", text: String(i) + "參考 text line\n".repeat(Math.ceil(chars / count / 13)),
      ...(complex ? { arguments: Object.fromEntries(Array.from({ length: 150 }, (_, n) => [String(n), { n }])) } : {}) }] }));
}
function median(samples: number[]) { return +samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)].toFixed(3); }
// Two calls model the prefix check and pending-context capture, without skipping
// either verification. They are actual bundled functions, not full ACP turns.
function compare(fn: any, messages: any[]) { fn(messages.slice(0, -1)); return fn(messages); }
for (const [name, messages] of [
  ["small", fixture(64_000)], ["1MB", fixture(1_000_000)], ["8MB", fixture(8_000_000)],
  ["complex", fixture(64_000, 100, true)],
] as const) {
  assert.equal(compare(optimized, messages), compare(baseline, messages));
  const warm: any = { baseline: [], optimized: [] }, cold: any = { baseline: [], optimized: [] };
  for (let i = 0; i < 15; i++) { compare(baseline, messages); compare(optimized, messages); }
  for (let sample = 0; sample < 15; sample++) {
    for (const key of sample % 2 ? ["optimized", "baseline"] : ["baseline", "optimized"]) {
      const fn = key === "baseline" ? baseline : optimized;
      let begin = performance.now();
      for (let repeat = 0; repeat < 5; repeat++) compare(fn, messages);
      warm[key].push((performance.now() - begin) / 5);
      const cloned = structuredClone(messages);
      begin = performance.now(); compare(fn, cloned); cold[key].push(performance.now() - begin);
    }
  }
  messages[0].content[0].text += "EDIT";
  assert.equal(compare(optimized, messages), compare(baseline, messages));
  console.log(JSON.stringify({ name, bytes: Buffer.byteLength(JSON.stringify(messages)),
    warmTwoPassMs: Object.fromEntries(Object.entries(warm).map(([k, v]) => [k, median(v as number[])])),
    coldTwoPassMs: Object.fromEntries(Object.entries(cold).map(([k, v]) => [k, median(v as number[])])) }));
}

const gc = (globalThis as any).gc;
if (gc) {
  const collect = async () => { for (let i = 0; i < 4; i++) {
    await immediate();
    if ((globalThis as any).Bun) (globalThis as any).Bun.gc(true);
    else gc();
  } };
  await collect();
  const empty = process.memoryUsage().heapUsed;
  async function prime() {
    const messages = fixture(16_000_000, 2000);
    baseline(messages); // Settle string flattening before counting cache overhead.
    await collect();
    const before = process.memoryUsage().heapUsed;
    optimized(messages);
    await collect();
    return { delta: process.memoryUsage().heapUsed - before, weak: new WeakRef(messages[0]) };
  }
  const retained = await prime();
  // A compacted replacement transcript must not hold the old weak keys alive.
  optimized(fixture(10_000, 2));
  await collect();
  const released = process.memoryUsage().heapUsed;
  console.log(JSON.stringify({ memory: { messages: 2000, snapshotHeapDeltaBytes: retained.delta,
    heapAboveEmptyAfterCompactionBytes: released - empty, oldMessageCollected: retained.weak.deref() === undefined },
    runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}` }));
} else console.log("Memory probe requires --expose-gc");
