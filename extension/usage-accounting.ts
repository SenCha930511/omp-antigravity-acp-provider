import { AcpFailure } from "./acp-errors.ts";

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

export interface AntigravityQuotaSnapshot {
  at: number;
  groups: Array<{
    displayName: string;
    buckets: Array<{ window: string; remainingFraction: number; resetTime?: string }>;
  }>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const QUOTA_GROUP = /^- \*\*(.+)\*\*$/u;
const QUOTA_BUCKET = /^ {2}- \*\*(.+?):\*\* (\d+)% remaining(?: \(resets (.+)\))?$/u;
const QUOTA_RESET = new RegExp(`^(${MONTHS.join("|")}) (\\d{1,2}), (\\d{4}), (\\d{2}):(\\d{2}) UTC$`, "u");
const UNIT_MS: Record<string, number> = { day: 86_400_000, hour: 3_600_000, minute: 60_000, second: 1_000 };
const QUOTA_NOTICE_PREFIX = "Usage Limit Reached\n\nYou have reached your current quota for this period.";
const QUOTA_NOTICE_RESET = /^ Your limit will reset (.+)\.$/u;
const QUOTA_RELATIVE_RESET = /^in ((?:\d+ (?:day|hour|minute|second)s?(?:, )?)+)$/u;
const QUOTA_ABSOLUTE_RESET = new RegExp(`^on (${MONTHS.join("|")}) (\\d{1,2}), (\\d{4}) (\\d{2}):(\\d{2}) UTC$`, "u");

function quotaResetDate(month: string, day: string, year: string, hours: string, minutes: string): Date | undefined {
  const monthIndex = MONTHS.indexOf(month);
  const dayNumber = Number(day), yearNumber = Number(year);
  const hourNumber = Number(hours), minuteNumber = Number(minutes);
  if (dayNumber < 1 || dayNumber > 31 || hourNumber > 23 || minuteNumber > 59) return;
  // Validate from a leap year, then apply the requested year so a valid
  // February 29 is not normalized before the component checks run.
  const date = new Date(Date.UTC(2000, monthIndex, dayNumber, hourNumber, minuteNumber));
  date.setUTCFullYear(yearNumber);
  if (date.getUTCFullYear() !== yearNumber || date.getUTCMonth() !== monthIndex || date.getUTCDate() !== dayNumber ||
    date.getUTCHours() !== hourNumber || date.getUTCMinutes() !== minuteNumber) return;
  return date;
}

function resetIso(text: string): string | undefined {
  const match = QUOTA_RESET.exec(text);
  if (!match) return undefined;
  const [, month, day, year, hours, minutes] = match;
  return quotaResetDate(month!, day!, year!, hours!, minutes!)?.toISOString();
}

export function parseUsageQuota(markdown: string, now = Date.now()): AntigravityQuotaSnapshot {
  const section = /^### Quota Limits$([\s\S]*?)(?=^### |(?![\s\S]))/mu.exec(markdown)?.[1] ?? "";
  const groups: AntigravityQuotaSnapshot["groups"] = [];
  let notice: string | undefined;
  for (const line of section.split("\n")) {
    const group = QUOTA_GROUP.exec(line);
    if (group) {
      groups.push({ displayName: group[1]!, buckets: [] });
      continue;
    }
    const bucket = QUOTA_BUCKET.exec(line);
    if (bucket && groups.length) {
      const [, label, percent, reset] = bucket;
      const resetTime = reset ? resetIso(reset) : undefined;
      if (reset && !resetTime) throw new AcpFailure("protocol", `Antigravity /usage reply had an invalid quota reset time: ${reset}`);
      groups.at(-1)!.buckets.push({
        window: /weekly/iu.test(label!) ? "weekly" : /five hour/iu.test(label!) ? "5h" : label!,
        remainingFraction: Number(percent) / 100,
        ...(resetTime ? { resetTime } : {}),
      });
      continue;
    }
    if (line.startsWith("- ")) notice ??= line.slice(2);
  }
  if (!groups.length) {
    const reason = notice ?? (markdown.trim() ? `unrecognized format (${markdown.length} characters)` : "no text returned");
    throw new AcpFailure("protocol", `Antigravity /usage reply had no quota groups: ${reason}`);
  }
  return { at: now, groups };
}

export function quotaExhaustion(text: string, now = Date.now()): { resetAt?: string } | undefined {
  const notice = text.trim();
  if (!notice.startsWith(QUOTA_NOTICE_PREFIX)) return undefined;
  const suffix = notice.slice(QUOTA_NOTICE_PREFIX.length);
  if (!suffix) return {};
  const reset = QUOTA_NOTICE_RESET.exec(suffix)?.[1];
  if (!reset) return undefined;
  const relative = QUOTA_RELATIVE_RESET.exec(reset)?.[1];
  if (relative) {
    let ms = 0;
    for (const [, count, unit] of relative.matchAll(/(\d+) (day|hour|minute|second)/gu)) {
      ms += Number(count) * UNIT_MS[unit!]!;
      if (!Number.isFinite(ms)) return {};
    }
    const resetAt = new Date(now + ms);
    return Number.isFinite(resetAt.getTime()) ? { resetAt: resetAt.toISOString() } : {};
  }
  const absolute = QUOTA_ABSOLUTE_RESET.exec(reset);
  if (absolute) {
    const [, month, day, year, hours, minutes] = absolute;
    const resetAt = quotaResetDate(month!, day!, year!, hours!, minutes!);
    return resetAt ? { resetAt: resetAt.toISOString() } : {};
  }
  // The exact official notice remains quota exhaustion even when its reset
  // wording is new; never invent a timestamp or treat it as assistant output.
  return {};
}
