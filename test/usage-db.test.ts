import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  conversationDbPath,
  decodeModelUsageStats,
  peekMaxModelStepIdx,
  readModelStepsAfter,
} from "../extension/usage-db.ts";

function varint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return bytes;
}

function varintField(tag: number, value: number): number[] {
  return [...varint(tag << 3), ...varint(value)];
}

function field(tag: number, payload: number[]): number[] {
  return [...varint((tag << 3) | 2), ...varint(payload.length), ...payload];
}

function metadata(usage: { input: number; output: number; cachedWrite: number; cachedRead: number; thought: number }): Uint8Array {
  return Uint8Array.from(field(9, [
    ...varintField(2, usage.input),
    ...varintField(3, usage.output),
    ...varintField(4, usage.cachedWrite),
    ...varintField(5, usage.cachedRead),
    ...varintField(9, usage.thought),
  ]));
}

async function fixture(): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-usage-db-"));
  const file = path.join(dir, "session.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)");
  const insert = db.prepare("INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)");
  insert.run(1, 15, 3, metadata({ input: 100, output: 20, cachedWrite: 5, cachedRead: 40, thought: 10 }));
  insert.run(2, 15, 3, metadata({ input: 200, output: 30, cachedWrite: 0, cachedRead: 60, thought: 15 }));
  insert.run(3, 14, 3, metadata({ input: 900, output: 900, cachedWrite: 0, cachedRead: 0, thought: 0 }));
  insert.run(4, 15, 2, metadata({ input: 900, output: 900, cachedWrite: 0, cachedRead: 0, thought: 0 }));
  db.close();
  return { dir, file };
}

test("decodes the model usage submessage from step metadata", () => {
  const decoded = decodeModelUsageStats(metadata({ input: 5492, output: 703, cachedWrite: 0, cachedRead: 0, thought: 687 }));
  assert.deepEqual(decoded, { inputTokens: 5492, outputTokens: 703, cachedWriteTokens: 0, cachedReadTokens: 0, thoughtTokens: 687 });
  assert.equal(decodeModelUsageStats(Uint8Array.from([0xff])), undefined);
});

test("reads only completed model steps after the cursor", async () => {
  const { dir, file } = await fixture();
  try {
    assert.equal(peekMaxModelStepIdx(file), 2);
    const batch = readModelStepsAfter(file, 0);
    assert.equal(batch?.calls, 2);
    assert.equal(batch?.maxIdx, 2);
    assert.deepEqual(batch?.usage, {
      inputTokens: 300,
      outputTokens: 50,
      cachedWriteTokens: 5,
      cachedReadTokens: 100,
      thoughtTokens: 25,
      totalTokens: 455,
    });
    assert.equal(readModelStepsAfter(file, 2), undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("missing or malformed stores fail closed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-usage-db-missing-"));
  try {
    const missing = path.join(dir, "missing.db");
    assert.equal(peekMaxModelStepIdx(missing), -1);
    assert.equal(readModelStepsAfter(missing, 0), undefined);
    assert.equal(conversationDbPath("/acp", "session"), path.join("/acp", "conversations", "session.db"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
