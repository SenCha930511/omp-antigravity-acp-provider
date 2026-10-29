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
	const tier = quota.tier ?? quota.plan;
	const model = quota.model ?? quota.modelId;
	const snapshot: QuotaSnapshot = {
		...(remaining !== undefined ? { remaining } : {}),
		...(limit !== undefined ? { limit } : {}),
		...(typeof reset === "string" || typeof reset === "number"
			? { resetAt: typeof reset === "number" ? new Date(reset > 1e12 ? reset : reset * 1000).toISOString() : reset }
			: {}),
		...(typeof tier === "string" ? { tier } : {}),
		...(typeof model === "string" ? { model } : {}),
	};
	return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
