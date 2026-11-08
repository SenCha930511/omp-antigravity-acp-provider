export interface PermissionDecision {
  outcome:
    | { outcome: "selected"; optionId: string }
    | { outcome: "cancelled" };
}

interface ToolIdentity {
  server?: string;
  tool?: string;
  kind?: string;
}

interface ToolRecord {
  turn: number;
  identity: ToolIdentity;
  conflict: boolean;
}

type UnknownRecord = Record<string, unknown>;

const SERVER_KEYS = ["mcpServerName", "serverName", "server"] as const;
const TOOL_KEYS = ["mcpToolName", "toolName", "tool"] as const;

export class PermissionIdentityRegistry {
  private readonly records = new Map<string, Map<string, ToolRecord>>();
  private readonly seen = new Map<string, Map<string, number>>();

  beginTurn(sessionId: string, turn: number): void {
    const seen = this.seen.get(sessionId);
    if (seen) {
      for (const [toolCallId, seenTurn] of seen) {
        if (seenTurn < turn - 1) seen.delete(toolCallId);
      }
    }
    const session = this.records.get(sessionId);
    if (!session) return;
    for (const [toolCallId, record] of session) {
      if (record.turn !== turn) session.delete(toolCallId);
    }
  }

  forget(sessionId: string): void {
    this.seen.delete(sessionId);
    this.records.delete(sessionId);
  }

  clear(): void {
    this.seen.clear();
    this.records.clear();
  }

  record(sessionId: string, turn: number, update: unknown): void {
    if (!isPlainObject(update)) return;
    const kind = update.sessionUpdate;
    if (kind !== "tool_call" && kind !== "tool_call_update") return;
    const toolCallId = stringValue(update.toolCallId);
    if (!toolCallId) return;
    const seenTurn = this.seen.get(sessionId)?.get(toolCallId);
    if (seenTurn !== undefined && seenTurn !== turn) return;
    this.seenFor(sessionId).set(toolCallId, turn);
    const session = this.sessionRecords(sessionId);
    const existing = session.get(toolCallId);
    if (existing && existing.turn !== turn) {
      session.delete(toolCallId);
    }
    const current = session.get(toolCallId) ?? { turn, identity: {}, conflict: false };
    current.turn = turn;
    const meta = isPlainObject(update._meta) ? update._meta : undefined;
    this.merge(current, "server", fieldValue(update, meta, SERVER_KEYS));
    this.merge(current, "tool", fieldValue(update, meta, TOOL_KEYS));
    this.merge(current, "kind", kindValue(update.kind));
    session.set(toolCallId, current);
  }

  check(sessionId: string, turn: number, request: unknown): PermissionDecision | undefined {
    if (!isPlainObject(request)) return reject(request);
    const toolCall = isPlainObject(request.toolCall) ? request.toolCall : undefined;
    const toolCallId = toolCall ? stringValue(toolCall.toolCallId) : undefined;
    if (!toolCallId) return reject(request);
    const record = this.records.get(sessionId)?.get(toolCallId);
    if (!record && this.seen.get(sessionId)?.has(toolCallId)) return reject(request);
    if (record && record.turn !== turn) return reject(request);
    const meta = toolCall && isPlainObject(toolCall._meta) ? toolCall._meta : undefined;
    const claimedServer = toolCall ? fieldValue(toolCall, meta, SERVER_KEYS) : undefined;
    const claimedTool = toolCall ? fieldValue(toolCall, meta, TOOL_KEYS) : undefined;
    const claimedKind = toolCall ? kindValue(toolCall.kind) : undefined;
    if (!record) {
      if (claimedServer !== undefined || claimedTool !== undefined) return reject(request);
      return undefined;
    }
    if (record.conflict) return reject(request);
    if (conflicts(record.identity.server, claimedServer)) return reject(request);
    if (conflicts(record.identity.tool, claimedTool)) return reject(request);
    if (conflicts(record.identity.kind, claimedKind)) return reject(request);
    return undefined;
  }

  private sessionRecords(sessionId: string): Map<string, ToolRecord> {
    let session = this.records.get(sessionId);
    if (!session) {
      session = new Map();
      this.records.set(sessionId, session);
    }
    return session;
  }
  private seenFor(sessionId: string): Map<string, number> {
    let seen = this.seen.get(sessionId);
    if (!seen) {
      seen = new Map();
      this.seen.set(sessionId, seen);
    }
    return seen;
  }

  private merge(record: ToolRecord, field: keyof ToolIdentity, value: string | null | undefined): void {
    if (value === undefined) return;
    if (value === null) {
      if (record.identity[field] !== undefined) record.conflict = true;
      delete record.identity[field];
      return;
    }
    const current = record.identity[field];
    if (current !== undefined && current !== value) {
      record.conflict = true;
      return;
    }
    record.identity[field] = value;
  }
}

function conflicts(current: string | undefined, claimed: string | null | undefined): boolean {
  if (claimed === undefined) return false;
  if (claimed === null) return current !== undefined;
  return current !== undefined && current !== claimed;
}

function reject(request: unknown): PermissionDecision {
  const options = isPlainObject(request) && Array.isArray(request.options) ? request.options : [];
  for (const option of options) {
    if (!isPlainObject(option)) continue;
    if (option.kind === "reject_once" || option.optionId === "reject_once") {
      const optionId = stringValue(option.optionId);
      if (optionId) return { outcome: { outcome: "selected", optionId } };
    }
  }
  return { outcome: { outcome: "cancelled" } };
}

function fieldValue(
  record: UnknownRecord,
  meta: UnknownRecord | undefined,
  keys: readonly string[],
): string | null | undefined {
  let sawNull = false;
  for (const source of [record, meta]) {
    if (!source) continue;
    for (const key of keys) {
      if (!Object.hasOwn(source, key)) continue;
      const value = source[key];
      if (value === null) {
        sawNull = true;
        continue;
      }
      const text = stringValue(value);
      if (text) return text;
    }
  }
  return sawNull ? null : undefined;
}

function kindValue(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return stringValue(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isPlainObject(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
