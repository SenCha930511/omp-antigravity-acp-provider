import { existsSync } from "node:fs";
import { createRequire as makeRequire } from "node:module";
import path from "node:path";

export interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  cachedWriteTokens: number;
  cachedReadTokens: number;
  thoughtTokens: number;
}

export interface StepUsageBatch {
  maxIdx: number;
  calls: number;
  usage: StepUsage & { totalTokens: number };
}

export interface UsageDatabase {
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  exec?(sql: string): unknown;
  close(): void;
}

export type UsageDatabaseOpener = (dbPath: string) => UsageDatabase;

export type BunDatabaseConstructor = new (dbPath: string, options?: { readonly?: boolean }) => UsageDatabase;
export type NodeDatabaseConstructor = new (dbPath: string, options?: { readOnly?: boolean; timeout?: number }) => UsageDatabase;

export interface BunSqliteModule {
  Database?: BunDatabaseConstructor;
}

export interface NodeSqliteModule {
  DatabaseSync?: NodeDatabaseConstructor;
}

// Module loading is injected so the selection rules stay testable without
// either host, and so a runtime without SQLite is probed at most once.
export interface UsageSqliteRuntime {
  bun: boolean;
  loadBunSqlite(): BunSqliteModule | undefined;
  loadNodeSqlite(): NodeSqliteModule | undefined;
}

function nativeUsageSqliteRuntime(): UsageSqliteRuntime {
  return {
    bun: typeof (process.versions as Record<string, string | undefined>).bun === "string",
    loadBunSqlite: () => {
      // Keep the specifier non-literal: a node-targeted bundle must not try to
      // resolve bun:sqlite, and only the Bun host can load it.
      const specifier = "bun:sqlite";
      return makeRequire(import.meta.url)(specifier) as BunSqliteModule | undefined;
    },
    loadNodeSqlite: () => {
      const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
      return getBuiltin?.("node:sqlite") as NodeSqliteModule | undefined;
    },
  };
}

// Both hosts are opened read-only: this store belongs to the ACP server, and
// accounting must never create, migrate, or lock it for writing.
function bunOpener(Database: BunDatabaseConstructor): UsageDatabaseOpener {
  return dbPath => {
    const db = new Database(dbPath, { readonly: true });
    try { db.exec?.("PRAGMA busy_timeout = 100;"); } catch { /* Best-effort lock timeout. */ }
    return db;
  };
}

function nodeOpener(Database: NodeDatabaseConstructor): UsageDatabaseOpener {
  return dbPath => new Database(dbPath, { readOnly: true, timeout: 100 });
}

export function selectUsageDatabaseOpener(runtime: UsageSqliteRuntime): UsageDatabaseOpener | undefined {
  // OMP runs under Bun, where bun:sqlite is the complete implementation; the
  // node:sqlite shim is the fallback for Node hosts and for a Bun build that
  // cannot load its own module.
  if (runtime.bun) {
    try {
      const Database = runtime.loadBunSqlite()?.Database;
      if (typeof Database === "function") return bunOpener(Database);
    } catch { /* Fall through to node:sqlite. */ }
  }
  try {
    const Database = runtime.loadNodeSqlite()?.DatabaseSync;
    if (typeof Database === "function") return nodeOpener(Database);
  } catch { /* No SQLite in this runtime; accounting stays unavailable. */ }
  return undefined;
}

export function createUsageDatabaseOpenerResolver(
  runtime: UsageSqliteRuntime = nativeUsageSqliteRuntime(),
): () => UsageDatabaseOpener | undefined {
  let cached: UsageDatabaseOpener | null | undefined;
  return () => {
    if (cached === undefined) cached = selectUsageDatabaseOpener(runtime) ?? null;
    return cached ?? undefined;
  };
}

const resolveUsageDatabaseOpener = createUsageDatabaseOpenerResolver();

const ACP_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

export function conversationDbPath(acpDirectory: string, sessionId: string): string | undefined {
  // A server-provided id is an opaque identity, never a path component.
  // Unknown formats degrade to unavailable usage rather than escaping ACP data.
  if (!ACP_SESSION_ID.test(sessionId)) return undefined;
  return path.join(acpDirectory, "conversations", `${sessionId}.db`);
}

function readVarint(buf: Uint8Array, offset: number): { value: bigint; next: number } | undefined {
  let value = 0n;
  let shift = 0n;
  for (let index = 0; index < 10; index++) {
    const byte = buf[offset + index];
    if (byte === undefined) return undefined;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: offset + index + 1 };
    shift += 7n;
  }
  return undefined;
}

function count(raw: bigint): number {
  const signed = BigInt.asIntN(64, raw);
  if (signed <= 0n) return 0;
  return signed > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(signed);
}

function parseUsageSubmessage(buf: Uint8Array, target: StepUsage): boolean {
  let position = 0;
  while (position < buf.length) {
    const tag = readVarint(buf, position);
    if (tag === undefined) return false;
    position = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (field <= 0) return false;
    if (wire === 0) {
      const value = readVarint(buf, position);
      if (value === undefined) return false;
      position = value.next;
      const decoded = count(value.value);
      if (field === 2) target.inputTokens = decoded;
      else if (field === 3) target.outputTokens = decoded;
      else if (field === 4) target.cachedWriteTokens = decoded;
      else if (field === 5) target.cachedReadTokens = decoded;
      else if (field === 9) target.thoughtTokens = decoded;
    } else if (wire === 1) {
      if (position + 8 > buf.length) return false;
      position += 8;
    } else if (wire === 2) {
      const length = readVarint(buf, position);
      if (length === undefined) return false;
      const bytes = Number(length.value);
      if (length.value < 0n || !Number.isSafeInteger(bytes) || length.next + bytes > buf.length) return false;
      position = length.next + bytes;
    } else if (wire === 5) {
      if (position + 4 > buf.length) return false;
      position += 4;
    } else {
      return false;
    }
  }
  return true;
}

export function decodeModelUsageStats(metadata: Uint8Array): StepUsage | undefined {
  let position = 0;
  let found = false;
  const stats: StepUsage = { inputTokens: 0, outputTokens: 0, cachedWriteTokens: 0, cachedReadTokens: 0, thoughtTokens: 0 };
  while (position < metadata.length) {
    const tag = readVarint(metadata, position);
    if (tag === undefined) return undefined;
    position = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (field <= 0) return undefined;
    if (wire === 0) {
      const value = readVarint(metadata, position);
      if (value === undefined) return undefined;
      position = value.next;
    } else if (wire === 1) {
      if (position + 8 > metadata.length) return undefined;
      position += 8;
    } else if (wire === 2) {
      const length = readVarint(metadata, position);
      if (length === undefined) return undefined;
      const bytes = Number(length.value);
      if (length.value < 0n || !Number.isSafeInteger(bytes) || length.next + bytes > metadata.length) return undefined;
      if (field === 9) {
        if (!parseUsageSubmessage(metadata.subarray(length.next, length.next + bytes), stats)) return undefined;
        found = true;
      }
      position = length.next + bytes;
    } else if (wire === 5) {
      if (position + 4 > metadata.length) return undefined;
      position += 4;
    } else {
      return undefined;
    }
  }
  return found ? stats : undefined;
}

export function peekMaxModelStepIdx(dbPath: string): number | undefined {
  if (!existsSync(dbPath)) return -1;
  const openDb = resolveUsageDatabaseOpener();
  if (openDb === undefined) return undefined;
  try {
    const db = openDb(dbPath);
    try {
      const row = db.prepare("SELECT COALESCE(MAX(idx), -1) AS maxIdx FROM steps WHERE step_type = 15 AND status = 3").get();
      const raw = row?.maxIdx;
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      if (typeof raw === "bigint") return Number(raw);
      return undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export function readModelStepsAfter(dbPath: string, afterIdx: number): StepUsageBatch | undefined {
  if (!existsSync(dbPath)) return undefined;
  const openDb = resolveUsageDatabaseOpener();
  if (openDb === undefined) return undefined;
  try {
    const db = openDb(dbPath);
    try {
      const rows = db.prepare("SELECT idx, metadata FROM steps WHERE step_type = 15 AND status = 3 AND idx > ? ORDER BY idx ASC").all(afterIdx);
      let maxIdx = afterIdx;
      let calls = 0;
      const usage: StepUsage = { inputTokens: 0, outputTokens: 0, cachedWriteTokens: 0, cachedReadTokens: 0, thoughtTokens: 0 };
      for (const row of rows) {
        const rawIdx = row.idx;
        const idx = typeof rawIdx === "number" && Number.isFinite(rawIdx) ? rawIdx : typeof rawIdx === "bigint" ? Number(rawIdx) : undefined;
        const rawMetadata = row.metadata;
        const metadata = rawMetadata instanceof Uint8Array
          ? rawMetadata
          : ArrayBuffer.isView(rawMetadata)
            ? new Uint8Array(rawMetadata.buffer, rawMetadata.byteOffset, rawMetadata.byteLength)
            : undefined;
        if (idx === undefined || metadata === undefined) continue;
        const decoded = decodeModelUsageStats(metadata);
        if (decoded === undefined) continue;
        if (idx > maxIdx) maxIdx = idx;
        calls++;
        usage.inputTokens += decoded.inputTokens;
        usage.outputTokens += decoded.outputTokens;
        usage.cachedWriteTokens += decoded.cachedWriteTokens;
        usage.cachedReadTokens += decoded.cachedReadTokens;
        usage.thoughtTokens += decoded.thoughtTokens;
      }
      if (calls === 0) return undefined;
      return {
        maxIdx,
        calls,
        usage: {
          ...usage,
          totalTokens: usage.inputTokens + usage.cachedReadTokens + usage.cachedWriteTokens + usage.outputTokens,
        },
      };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}
