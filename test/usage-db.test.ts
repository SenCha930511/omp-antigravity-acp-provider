import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  conversationDbPath,
  createUsageDatabaseOpenerResolver,
  decodeModelUsageStats,
  peekMaxModelStepIdx,
  readModelStepsAfter,
  selectUsageDatabaseOpener,
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
    const sessionId = "d0296cc1-d721-4027-8454-8556d05cbf80";
    assert.equal(conversationDbPath("/acp", sessionId), path.join("/acp", "conversations", `${sessionId}.db`));
    assert.equal(conversationDbPath("/acp", "../../../etc/passwd"), undefined);
    assert.equal(conversationDbPath("/acp", "/tmp/other.db"), undefined);
    assert.equal(conversationDbPath("/acp", "session"), undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an unreadable store is unavailable while an empty store has no steps", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-usage-db-unreadable-"));
  try {
    const corrupt = path.join(dir, "corrupt.db");
    await fs.writeFile(corrupt, "not a sqlite database");
    assert.equal(peekMaxModelStepIdx(corrupt), undefined);

    const empty = path.join(dir, "empty.db");
    const db = new DatabaseSync(empty);
    db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)");
    db.close();
    assert.equal(peekMaxModelStepIdx(empty), -1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("prefers bun:sqlite read-only and sets a bounded busy timeout", () => {
  const opened: Array<{ path: string; options?: { readonly?: boolean } }> = [];
  const executed: string[] = [];
  class FakeBunDatabase {
    constructor(path: string, options?: { readonly?: boolean }) { opened.push({ path, options }); }
    exec(sql: string) { executed.push(sql); return undefined; }
    prepare() { return { get: () => undefined, all: () => [] }; }
    close() {}
  }
  const opener = selectUsageDatabaseOpener({
    bun: true,
    loadBunSqlite: () => ({ Database: FakeBunDatabase }),
    loadNodeSqlite: () => { throw new Error("node:sqlite must not be probed when Bun provides SQLite"); },
  });
  assert.ok(opener);
  const db = opener("/tmp/session.db");
  assert.deepEqual(opened, [{ path: "/tmp/session.db", options: { readonly: true } }]);
  assert.deepEqual(executed, ["PRAGMA busy_timeout = 100;"]);
  db.close();
});

test("falls back to node:sqlite when the Bun module cannot load", () => {
  const opened: Array<{ path: string; options?: { readOnly?: boolean; timeout?: number } }> = [];
  class FakeNodeDatabase {
    constructor(path: string, options?: { readOnly?: boolean; timeout?: number }) { opened.push({ path, options }); }
    prepare() { return { get: () => undefined, all: () => [] }; }
    close() {}
  }
  const opener = selectUsageDatabaseOpener({
    bun: true,
    loadBunSqlite: () => { throw new Error("no bun:sqlite here"); },
    loadNodeSqlite: () => ({ DatabaseSync: FakeNodeDatabase }),
  });
  assert.ok(opener);
  opener("/tmp/session.db").close();
  assert.deepEqual(opened, [{ path: "/tmp/session.db", options: { readOnly: true, timeout: 100 } }]);
});

test("a runtime without SQLite is probed once and stays unavailable", () => {
  let bunLoads = 0;
  let nodeLoads = 0;
  const resolve = createUsageDatabaseOpenerResolver({
    bun: true,
    loadBunSqlite: () => { bunLoads++; return undefined; },
    loadNodeSqlite: () => { nodeLoads++; return undefined; },
  });
  assert.equal(resolve(), undefined);
  assert.equal(resolve(), undefined);
  assert.equal(bunLoads, 1);
  assert.equal(nodeLoads, 1);
});

test("the selected opener is cached for the runtime", () => {
  class FakeNodeDatabase {
    prepare() { return { get: () => undefined, all: () => [] }; }
    close() {}
  }
  let loads = 0;
  const resolve = createUsageDatabaseOpenerResolver({
    bun: false,
    loadBunSqlite: () => { throw new Error("Bun must not be probed on a Node host"); },
    loadNodeSqlite: () => { loads++; return { DatabaseSync: FakeNodeDatabase }; },
  });
  const opener = resolve();
  assert.ok(opener, "node:sqlite must provide an opener");
  assert.equal(resolve(), opener, "the selected opener must be cached");
  assert.equal(loads, 1);
});

test("an existing store is read without creating or mutating files", async () => {
  const { dir, file } = await fixture();
  try {
    const before = await fs.readFile(file);
    const beforeStat = await fs.stat(file);
    assert.equal(peekMaxModelStepIdx(file), 2);
    assert.equal(readModelStepsAfter(file, 0)?.calls, 2);
    assert.deepEqual(await fs.readFile(file), before);
    assert.equal((await fs.stat(file)).mtimeMs, beforeStat.mtimeMs);
    const missing = path.join(dir, "absent.db");
    assert.equal(peekMaxModelStepIdx(missing), -1);
    assert.equal(readModelStepsAfter(missing, 0), undefined);
    await assert.rejects(fs.stat(missing), /ENOENT/u, "accounting must never create a session store");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
