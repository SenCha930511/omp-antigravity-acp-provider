import type {
	NewSessionResponse,
	SessionConfigOption,
	SessionConfigSelectOption,
	SessionModeState,
} from "@agentclientprotocol/sdk";
import { z } from "zod";

import { AntigravityAcpError } from "./errors.js";

/** Antigravity's pre-config-option model metadata remains on older ACP v1 servers. */
export interface AcpModelInfo {
	modelId: string;
	name: string;
}

export interface SessionState {
	modes?: SessionModeState | null;
	configOptions?: SessionConfigOption[] | null;
	models?: { currentModelId: string; availableModels: AcpModelInfo[] } | null;
}

export type AcpNewSessionResponse = NewSessionResponse & SessionState;
type SelectOption = Extract<SessionConfigOption, { type: "select" }>;
const valueSchema = z.object({ value: z.string(), name: z.string() });
const selectorBase = { id: z.string(), name: z.string(), category: z.string().nullish() };
const stateSchema = z.object({
	modes: z.object({ currentModeId: z.string(), availableModes: z.array(z.object({ id: z.string(), name: z.string() })) }).nullish(),
	configOptions: z.array(z.discriminatedUnion("type", [
		z.object({ ...selectorBase, type: z.literal("select"), currentValue: z.string(), options: z.union([
			z.array(valueSchema),
			z.array(z.object({ group: z.string(), name: z.string(), options: z.array(valueSchema) })),
		]) }),
		z.object({ ...selectorBase, type: z.literal("boolean"), currentValue: z.boolean() }),
	])).nullish(),
	models: z.object({ currentModelId: z.string(), availableModels: z.array(z.object({ modelId: z.string(), name: z.string() })) }).nullish(),
});

/** SDK 1.x no longer exports response validators or draft model types. Validate
 * the state we use explicitly, preserving legacy metadata without private imports. */
export function decodeSessionState(response: unknown): SessionState {
	const parsed = stateSchema.safeParse(response);
	if (!parsed.success) throw new AntigravityAcpError("protocol", "Invalid ACP session configuration");
	// JSON responses cannot contain explicit undefined properties; Zod's optional
	// property inference is broader than the SDK's exact-optional declarations.
	return parsed.data as SessionState;
}

export function findSessionSelector(state: SessionState, category: "model" | "mode"): SelectOption | undefined {
	return state.configOptions?.find((option): option is SelectOption =>
		option.type === "select" && (option.category === category || option.id === category),
	);
}

export function selectorValues(option: SelectOption): SessionConfigSelectOption[] {
	return option.options.flatMap((entry) => "options" in entry ? entry.options : [entry]);
}

export function sessionModels(state: SessionState): { currentModelId: string; availableModels: AcpModelInfo[] } | undefined {
	const selector = findSessionSelector(state, "model");
	if (!selector) return state.models ?? undefined;
	return {
		currentModelId: selector.currentValue,
		availableModels: selectorValues(selector).map((option) => ({ modelId: option.value, name: option.name })),
	};
}

export function sessionModes(state: SessionState): SessionModeState | null | undefined {
	const selector = findSessionSelector(state, "mode");
	if (!selector) return state.modes;
	return {
		currentModeId: selector.currentValue,
		availableModes: selectorValues(selector).map((option) => ({ id: option.value, name: option.name })),
	};
}

