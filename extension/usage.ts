import { usageFromPrompt as upstreamUsage } from "./runtime/stream/usage.ts";

// Named shape of the upstream usage projection (pi-ai Usage) plus this
// adapter's contextTokens extension, so callers never depend on
// ReturnType<typeof …>.
export interface PromptUsageResult {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  reasoning?: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  contextTokens?: number;
  contextTokensSource?: "server" | "estimate";
}

export function usageFromPrompt(
  response: Parameters<typeof upstreamUsage>[0] & { _meta?: { ompContextTokens?: unknown } | null },
  fallbackContextTokens?: number,
): PromptUsageResult {
  const usage: PromptUsageResult = upstreamUsage(response);
  const context = response._meta?.ompContextTokens;
  // OMP accepts contextTokens independently from aggregate billable tokens.
  // A server-reported occupancy always wins; the local estimate is only a
  // fallback for ACP runtimes that never send usage_update. Never derive
  // context from input/cacheRead: those are cumulative billing counters.
  if (typeof context === "number" && Number.isSafeInteger(context) && context >= 0) {
    usage.contextTokens = context;
    usage.contextTokensSource = "server";
  } else if (typeof fallbackContextTokens === "number" && Number.isSafeInteger(fallbackContextTokens) && fallbackContextTokens > 0) {
    usage.contextTokens = fallbackContextTokens;
    usage.contextTokensSource = "estimate";
  }
  return usage;
}
