import type { AntigravityQuotaSnapshot } from "./usage-accounting.ts";

export interface QuotaUsageAmount {
  unit: "percent";
  remainingFraction: number;
  usedFraction: number;
  remaining: number;
  used: number;
  limit: number;
}

export interface QuotaUsageWindow {
  id: string;
  label: string;
  durationMs?: number;
  resetsAt?: number;
}

export interface QuotaUsageScope {
  provider: string;
  modelId?: string;
  tier?: string;
  windowId?: string;
}

export interface QuotaUsageLimit {
  id: string;
  label: string;
  scope: QuotaUsageScope;
  window?: QuotaUsageWindow;
  amount: QuotaUsageAmount;
  status?: "ok" | "warning" | "exhausted";
}

export interface QuotaUsageReport {
  provider: string;
  fetchedAt: number;
  limits: QuotaUsageLimit[];
  metadata?: Record<string, unknown>;
}

export interface QuotaUsageOptions {
  provider?: string;
  modelIds?: readonly string[];
  cacheVersion?: number;
  failureBackoffMs?: number;
}

export interface QuotaUsageProviderParams {
  signal?: AbortSignal;
}

export interface QuotaUsageProviderLogger {
  debug?: (message: string, details?: unknown) => void;
}

export interface QuotaUsageProviderContext {
  logger?: QuotaUsageProviderLogger;
}

export interface QuotaUsageProvider {
  id: string;
  cacheVersion?: number;
  validatesCredentials?: boolean;
  retainLastGoodOnFailure?: boolean;
  failureBackoffMs?: number;
  fetchUsage(params: QuotaUsageProviderParams, ctx: QuotaUsageProviderContext): Promise<QuotaUsageReport | null>;
}

const DEFAULT_PROVIDER = "antigravity-acp";
const WEEK_MS = 604_800_000;
const FIVE_HOURS_MS = 18_000_000;
const DAY_MS = 86_400_000;

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "") || "quota";
}

function normalizeWindow(value: string): QuotaUsageWindow {
  const normalized = value.trim().toLowerCase();
  if (normalized === "weekly" || normalized === "7d") return { id: "7d", label: "7 Day", durationMs: WEEK_MS };
  if (normalized === "5h" || normalized === "five hour" || normalized === "5 hour") {
    return { id: "5h", label: "5 Hour", durationMs: FIVE_HOURS_MS };
  }
  if (normalized === "daily" || normalized === "24h") return { id: "daily", label: "Daily", durationMs: DAY_MS };
  if (normalized === "monthly") return { id: "monthly", label: "Monthly" };
  return { id: slug(value), label: value };
}

function matchedModelIds(groupName: string, modelIds: readonly string[] | undefined): string[] {
  if (!modelIds?.length) return [];
  const name = groupName.toLowerCase();
  const exact = modelIds.filter(id => slug(id) === slug(groupName));
  if (exact.length) return [...new Set(exact)];
  const wantsClaude = name.includes("claude");
  const wantsGpt = name.includes("gpt");
  let matches: string[];
  if (name.includes("argon")) {
    matches = modelIds.filter(id => id.toLowerCase().includes("argon"));
  } else if (name.includes("gemini")) {
    matches = modelIds.filter(id => {
      const value = id.toLowerCase();
      return value.includes("gemini") && !value.includes("argon");
    });
  } else if (wantsClaude || wantsGpt) {
    matches = modelIds.filter(id => {
      const value = id.toLowerCase();
      return (wantsClaude && value.includes("claude")) || (wantsGpt && value.includes("gpt"));
    });
  } else {
    return [];
  }
  return [...new Set(matches)];
}

function statusFor(remainingFraction: number): "ok" | "warning" | "exhausted" {
  if (remainingFraction <= 0) return "exhausted";
  if (remainingFraction <= 0.1) return "warning";
  return "ok";
}

export function quotaSnapshotToUsageReport(
  snapshot: AntigravityQuotaSnapshot,
  options: QuotaUsageOptions = {},
): QuotaUsageReport {
  const provider = options.provider ?? DEFAULT_PROVIDER;
  const modelIds = options.modelIds;
  const limits: QuotaUsageLimit[] = [];
  const usedIds = new Map<string, number>();
  for (const group of snapshot.groups) {
    const groupSlug = slug(group.displayName);
    const matches = matchedModelIds(group.displayName, modelIds);
    for (const bucket of group.buckets) {
      const window = normalizeWindow(bucket.window);
      const resetsAt = bucket.resetTime === undefined ? Number.NaN : Date.parse(bucket.resetTime);
      const remainingFraction = Number.isFinite(bucket.remainingFraction)
        ? Math.min(1, Math.max(0, bucket.remainingFraction)) : 0;
      const usedFraction = 1 - remainingFraction;
      for (const modelId of matches.length ? matches : [undefined]) {
        const scope: QuotaUsageScope = { provider, tier: group.displayName, windowId: window.id };
        if (modelId) scope.modelId = modelId;
        const baseId = `${provider}:${groupSlug}${modelId ? `:${slug(modelId)}` : ""}:${window.id}`;
        const seen = usedIds.get(baseId) ?? 0;
        usedIds.set(baseId, seen + 1);
        limits.push({
          id: seen === 0 ? baseId : `${baseId}-${seen + 1}`,
          label: `${group.displayName}${matches.length > 1 ? ` (${modelId})` : ""} ${window.label}`,
          scope,
          window: { ...window, ...(Number.isFinite(resetsAt) ? { resetsAt } : {}) },
          amount: {
            unit: "percent",
            remainingFraction,
            usedFraction,
            remaining: remainingFraction * 100,
            used: usedFraction * 100,
            limit: 100,
          },
          status: statusFor(remainingFraction),
        });
      }
    }
  }
  return {
    provider,
    fetchedAt: snapshot.at,
    limits,
    metadata: { source: "antigravity-acp-quota", groups: snapshot.groups.length },
  };
}

export function createQuotaUsageProvider(options: {
  loadSnapshot: (signal?: AbortSignal) => Promise<AntigravityQuotaSnapshot | undefined>;
  modelIds?: () => readonly string[];
  provider?: string;
  cacheVersion?: number;
  failureBackoffMs?: number;
  ttlMs?: number;
  now?: () => number;
}): QuotaUsageProvider {
  const provider = options.provider ?? DEFAULT_PROVIDER;
  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now ?? Date.now;
  let cached: { at: number; report: QuotaUsageReport } | undefined;
  let inFlight: {
    controller: AbortController;
    subscribers: number;
    promise: Promise<QuotaUsageReport | null>;
  } | undefined;
  return {
    id: provider,
    cacheVersion: options.cacheVersion ?? 2,
    validatesCredentials: false,
    retainLastGoodOnFailure: true,
    failureBackoffMs: options.failureBackoffMs ?? 60_000,
    async fetchUsage(params, ctx) {
      params.signal?.throwIfAborted();
      const at: number = now();
      if (ttlMs > 0 && cached && at - cached.at < ttlMs) return cached.report;
      let shared = inFlight;
      if (!shared) {
        const controller = new AbortController();
        let load: Promise<QuotaUsageReport | null> | undefined;
        load = (async () => {
          try {
            const snapshot = await options.loadSnapshot(controller.signal);
            if (!snapshot || controller.signal.aborted) return null;
            const report = quotaSnapshotToUsageReport(snapshot, {
              provider,
              ...(options.modelIds ? { modelIds: options.modelIds() } : {}),
            });
            if (!report.limits.length || controller.signal.aborted) return null;
            cached = { at: now(), report };
            return report;
          } finally {
            if (inFlight?.promise === load) inFlight = undefined;
          }
        })();
        shared = { controller, subscribers: 0, promise: load };
        inFlight = shared;
      }
      shared.subscribers++;
      const outcome = Promise.withResolvers<QuotaUsageReport | null>();
      let subscribed = true;
      const detach = () => {
        if (!subscribed) return;
        subscribed = false;
        shared.subscribers--;
        params.signal?.removeEventListener("abort", onAbort);
        if (shared.subscribers !== 0) return;
        if (inFlight?.promise === shared.promise) inFlight = undefined;
        shared.controller.abort();
      };
      const onAbort = () => {
        detach();
        outcome.reject(params.signal?.reason ?? new DOMException("Antigravity quota read was aborted", "AbortError"));
      };
      shared.promise.then(report => {
        detach();
        outcome.resolve(report);
      }, error => {
        const shouldLog = subscribed && !shared.controller.signal.aborted;
        detach();
        if (shouldLog) {
          ctx.logger?.debug?.("Antigravity quota unavailable", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        outcome.resolve(null);
      });
      params.signal?.addEventListener("abort", onAbort, { once: true });
      if (params.signal?.aborted) onAbort();
      return outcome.promise;
    },
  };
}
