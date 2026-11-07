export interface SessionUsage {
  input: number; completion: number; thinking: number; cached?: number; total: number;
}

export function parseSessionUsage(text: string): SessionUsage | undefined {
  const match = text.match(/\*\*Session total:\*\*\s*([\d,]+) tokens(?:\s*\(([^)]+)\))?/);
  if (!match) return;
  const total = Number(match[1].replaceAll(",", ""));
  const counts: Record<string, number> = {};
  for (const part of (match[2] ?? "").matchAll(/(prompt|completion|thinking|cached):\s*([\d,]+)/g)) counts[part[1]] = Number(part[2].replaceAll(",", ""));
  if (![total, ...Object.values(counts)].every(n => Number.isSafeInteger(n) && n >= 0)) return;
  if (!Object.keys(counts).length && total > 0) return;
  const usage = { input: counts.prompt ?? 0, completion: counts.completion ?? 0, thinking: counts.thinking ?? 0, cached: counts.cached, total };
  if (usage.cached !== undefined && usage.cached > usage.input) return;
  if (usage.input + usage.completion + usage.thinking > usage.total) return;
  return usage;
}

export function usageDelta(before: SessionUsage, after: SessionUsage) {
  const input = after.input - before.input;
  const completion = after.completion - before.completion;
  const thinking = after.thinking - before.thinking;
  const total = after.total - before.total;
  if ([input, completion, thinking, total].some(n => n < 0)) return;
  const cacheKnown = before.cached !== undefined && after.cached !== undefined;
  const cached = cacheKnown ? after.cached! - before.cached! : undefined;
  if (cached !== undefined && (cached < 0 || cached > input)) return;
  return { inputTokens: input, outputTokens: completion + thinking, thoughtTokens: thinking,
    totalTokens: total, ...(cached !== undefined ? { cachedReadTokens: cached } : {}) };
}
