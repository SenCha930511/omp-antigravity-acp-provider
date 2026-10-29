import { usageFromPrompt as upstreamUsage } from "./vendor/pi-antigravity-acp-provider/src/stream/usage.ts";

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
}

export function usageFromPrompt(response: Parameters<typeof upstreamUsage>[0] & { _meta?: { ompContextTokens?: unknown } }): PromptUsageResult {
  const usage: PromptUsageResult = upstreamUsage(response);
  const context = response._meta?.ompContextTokens;
  // OMP accepts contextTokens independently from aggregate billable tokens.
  if (typeof context === "number" && Number.isSafeInteger(context) && context >= 0) usage.contextTokens = context;
  return usage;
}
