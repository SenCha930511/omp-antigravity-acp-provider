import type { PromptResponse } from "@agentclientprotocol/sdk";
import type { Usage } from "@earendil-works/pi-ai";

export interface QuotaSnapshot {
	remaining?: number;
	limit?: number;
	resetAt?: string;
	tier?: string;
	model?: string;
}

export interface UsageTotals {
	turns: number;
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
}

export class RuntimeMetrics {
	readonly totals: UsageTotals = {
		turns: 0,
		input: 0,
		output: 0,
		reasoning: 0,
		cacheRead: 0,
		cacheWrite: 0,
	};
	latestQuota: QuotaSnapshot | undefined;

	record(response: PromptResponse, usage: Usage): void {
		this.totals.turns += 1;
		this.totals.input += usage.input;
		this.totals.output += usage.output;
		this.totals.reasoning += usage.reasoning ?? 0;
		this.totals.cacheRead += usage.cacheRead;
		this.totals.cacheWrite += usage.cacheWrite;
		this.latestQuota = quotaFromPrompt(response) ?? this.latestQuota;
	}

	snapshot(): { totals: UsageTotals; latestQuota?: QuotaSnapshot } {
		return {
			totals: { ...this.totals },
			...(this.latestQuota ? { latestQuota: { ...this.latestQuota } } : {}),
		};
	}
}

export function quotaFromPrompt(response: PromptResponse): QuotaSnapshot | undefined {
	const meta = record(response._meta);
	const quota = record(meta?.quota);
	if (!quota) return undefined;
	const remaining = number(quota.remainingRequests) ?? number(quota.remainingQueries) ?? number(quota.remaining);
	const limit = number(quota.requestLimit) ?? number(quota.queryLimit) ?? number(quota.limit);
	const reset = quota.resetTimestamp ?? quota.resetAt ?? quota.reset_time;
	const resetAt = resetTimestamp(reset);
	const tier = quota.tier ?? quota.plan;
	const model = quota.model ?? quota.modelId;
	const snapshot: QuotaSnapshot = {
		...(remaining !== undefined ? { remaining } : {}),
		...(limit !== undefined ? { limit } : {}),
		...(resetAt !== undefined ? { resetAt } : {}),
		...(typeof tier === "string" ? { tier } : {}),
		...(typeof model === "string" ? { model } : {}),
	};
	return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

// Only finite safe-integer epoch values whose millisecond conversion lands in
// the Date range may become a reset timestamp. A malformed number must not
// throw away the remaining/limit metadata that arrived with it.
function resetTimestamp(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined;
	const milliseconds = value > 1e12 ? value : value * 1000;
	if (!Number.isSafeInteger(milliseconds) || Math.abs(milliseconds) > 8.64e15) return undefined;
	return new Date(milliseconds).toISOString();
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
