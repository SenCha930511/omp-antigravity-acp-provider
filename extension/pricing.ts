import { splitLegacyEffort } from "./efforts.ts";

// USD per 1M tokens, Gemini Developer API Standard tier.
// Source: https://ai.google.dev/gemini-api/docs/pricing (checked 2026-10-19).
// These are API-equivalent estimates, not Antigravity subscription charges.
export function officialApiCost(modelId: string, at = Date.now()) {
  const id = splitLegacyEffort(modelId)?.base ?? modelId;
  if (id === "gemini-4-argon") {
    // Use the undiscounted list price, ignoring introductory rates.
    return { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 };
  }
  if (id === "gemini-3.8-flash") {
    // Flash retains its published current rate, then the announced 2027 rate.
    const multiplier = at < Date.UTC(2027, 0, 1) ? 1 : 2;
    return { input: 0.75 * multiplier, output: 3.75 * multiplier, cacheRead: 0.075 * multiplier, cacheWrite: 0 };
  }
  return undefined;
}

export function applyApiCostEstimate(
  modelId: string,
  usage: { input?: unknown; output?: unknown; cacheRead?: unknown; cost?: unknown } | undefined,
  at = Date.now(),
) {
  const rates = officialApiCost(modelId, at);
  if (!rates || !usage) return;
  const tokens = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  const cost = {
    input: rates.input * tokens(usage.input) / 1_000_000,
    output: rates.output * tokens(usage.output) / 1_000_000,
    cacheRead: rates.cacheRead * tokens(usage.cacheRead) / 1_000_000,
    // Google publishes no separate per-token cache-write fee; storage/time
    // and grounding charges are outside this token-only estimate.
    cacheWrite: 0,
    total: 0,
  };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  usage.cost = cost;
}
