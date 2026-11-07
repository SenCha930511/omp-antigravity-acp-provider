// ACP compaction is server-owned context maintenance. Keep its display state
// separate from OMP's transcript so a server summary never becomes fake
// assistant text or a second OMP compaction.
export type AcpCompactionStatus = string;

export interface AcpCompactionRecord {
  sessionId: string;
  compactionId: string;
  status: AcpCompactionStatus;
  summary: string;
  error?: string;
  updatedAt: number;
  notified: boolean;
}

export interface AcpCompactionNotice {
  sessionId: string;
  compactionId: string;
  status: AcpCompactionStatus;
  summary: string;
  error?: string;
}

export interface CompactionUpdateLike {
  compactionId?: unknown;
  status?: unknown;
  summary?: unknown;
  error?: unknown;
}

export interface CompactionChunkLike {
  compactionId?: unknown;
  content?: unknown;
}

export function isTerminalCompaction(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("\n");
}

export function compactionSummary(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "";
  return contentText(value);
}

export function applyCompactionUpdate(
  previous: AcpCompactionRecord | undefined,
  sessionId: string,
  update: CompactionUpdateLike,
  now = Date.now(),
): AcpCompactionRecord | undefined {
  if (typeof update.compactionId !== "string" || !update.compactionId) return previous;
  if (typeof update.status !== "string" || !update.status) return previous;
  const summary = compactionSummary(update.summary);
  const errorProvided = update.error === null || typeof update.error === "string";
  const error = typeof update.error === "string" ? update.error : undefined;
  return {
    sessionId,
    compactionId: update.compactionId,
    status: update.status,
    summary: summary === undefined ? previous?.summary ?? "" : summary,
    ...(errorProvided ? (error !== undefined ? { error } : {}) : previous?.error !== undefined ? { error: previous.error } : {}),
    updatedAt: now,
    notified: previous?.notified ?? false,
  };
}

export function applyCompactionChunk(
  previous: AcpCompactionRecord | undefined,
  sessionId: string,
  chunk: CompactionChunkLike,
  now = Date.now(),
): AcpCompactionRecord | undefined {
  if (typeof chunk.compactionId !== "string" || !chunk.compactionId) return previous;
  const text = contentText([chunk.content]);
  if (!text) return previous;
  return {
    sessionId,
    compactionId: chunk.compactionId,
    status: previous?.status ?? "in_progress",
    summary: (previous?.summary ?? "") + text,
    ...(previous?.error !== undefined ? { error: previous.error } : {}),
    updatedAt: now,
    notified: previous?.notified ?? false,
  };
}

export function formatCompactionNotice(notice: AcpCompactionNotice): string {
  const prefix = "Antigravity ACP";
  if (notice.status === "completed") {
    const summary = notice.summary.trim();
    const preview = summary.length > 320 ? `${summary.slice(0, 317)}...` : summary;
    return `${prefix} compacted its context${preview ? `: ${preview}` : "."} OMP history was retained.`;
  }
  if (notice.status === "failed") {
    return `${prefix} compaction failed${notice.error ? `: ${notice.error}` : "."} OMP history was retained.`;
  }
  if (notice.status === "cancelled") return `${prefix} compaction was cancelled. OMP history was retained.`;
  return `${prefix} compaction status: ${notice.status}.`;
}

// OMP compacts against its own model.contextWindow. ACP reports the server's
// actual window in usage_update.size, so normalize the occupancy before OMP's
// 85% decision. Without both values, preserve the raw server count.
export function alignContextTokens(used: number, size: number, ompContextWindow?: number): number {
  if (!Number.isSafeInteger(used) || used < 0) return used;
  if (!Number.isSafeInteger(size) || size <= 0) return used;
  if (!Number.isSafeInteger(ompContextWindow) || ompContextWindow === undefined || ompContextWindow <= 0) return used;
  const scaled = Math.round((used / size) * ompContextWindow);
  return Number.isSafeInteger(scaled) && scaled >= 0 ? scaled : used;
}
