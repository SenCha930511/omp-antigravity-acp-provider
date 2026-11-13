import { splitLegacyEffort } from "./efforts.ts";

export interface ApiTokenRate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

type RateSource = ApiTokenRate | ((at: number) => ApiTokenRate);

interface RateRule {
  match: string | RegExp;
  rates: RateSource;
}

// USD per 1M tokens, API list prices. These are API-equivalent estimates,
// not Antigravity subscription charges.
//
// Checked 2026-11-13:
// - Gemini: https://aistudio.google.com/docs/pricing and
//   https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-hydrogen/
// - Claude: https://platform.claude.com/docs/en/about-claude/pricing
// - GPT-OSS: OpenAI-compatible list estimate; the OpenAI model page itself
//   does not publish a per-token price.
//
// Keep exact IDs before patterns. `splitLegacyEffort` strips the advertised
// effort suffix, so `claude-opus-5-5-high` resolves to the same entry.
const RATE_RULES: readonly RateRule[] = [
  {
    match: "gemini-4-argon",
    // Use the undiscounted list price, ignoring the introductory rate.
    rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
  },
  {
    match: "gemini-4-hydrogen",
    // Implicit caching only on the Gemini API; no separate cache-write fee.
    rates: { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 },
  },
  {
    match: "gemini-3.8-flash",
    // Flash retains its published current rate, then the announced 2027 rate.
    rates: at => {
      const multiplier = at < Date.UTC(2027, 0, 1) ? 1 : 2;
      return {
        input: 0.75 * multiplier,
        output: 3.75 * multiplier,
        cacheRead: 0.075 * multiplier,
        cacheWrite: 0,
      };
    },
  },
  {
    match: "gemini-pro-orchestrator-g1-pro",
    // Orchestrator (Argon) mixes Argon planning with Hydrogen execution. A
    // single token rate cannot be exact; use the Argon planner rate as a
    // conservative API-equivalent estimate.
    rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
  },
  {
    match: "claude-opus-5-5",
    // 5-minute cache writes. 1-hour cache writes are a separate higher rate.
    rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  },
  {
    match: "claude-sonnet-5-5",
    // 5-minute cache writes. 1-hour cache writes are a separate higher rate.
    rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  },
  {
    match: "gpt-oss-120b",
    // Provider-listed OSS rate; not an OpenAI first-party token price.
    rates: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
  },
];

function normalizeModelId(modelId: string): string {
  const base = splitLegacyEffort(modelId)?.base ?? modelId;
  return base.replace(/^models\//u, "");
}

export function officialApiCost(modelId: string, at = Date.now()): ApiTokenRate | undefined {
  const id = normalizeModelId(modelId);
  for (const rule of RATE_RULES) {
    const matched = typeof rule.match === "string" ? id === rule.match : rule.match.test(id);
    if (!matched) continue;
    return typeof rule.rates === "function" ? rule.rates(at) : rule.rates;
  }
  return undefined;
}

export function applyApiCostEstimate(
  modelId: string,
  usage: {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    cost?: unknown;
  } | undefined,
  at = Date.now(),
) {
  const rates = officialApiCost(modelId, at);
  if (!rates || !usage) return;
  const tokens = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  const cost = {
    input: rates.input * tokens(usage.input) / 1_000_000,
    output: rates.output * tokens(usage.output) / 1_000_000,
    cacheRead: rates.cacheRead * tokens(usage.cacheRead) / 1_000_000,
    cacheWrite: rates.cacheWrite * tokens(usage.cacheWrite) / 1_000_000,
    total: 0,
  };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  usage.cost = cost;
}
