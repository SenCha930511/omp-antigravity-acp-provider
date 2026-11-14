import { parseThoughtRoute, splitLegacyEffort, validId, type AdvertisedModel } from "./model-catalog.ts";

export interface ConfigOptionChoice {
  value?: unknown;
  name?: unknown;
  options?: ReadonlyArray<ConfigOptionChoice> | null;
}

export interface ConfigOption {
  id: string;
  type?: string | null;
  category?: string | null;
  description?: string | null;
  currentValue?: string | boolean | null;
  options?: ReadonlyArray<ConfigOptionChoice> | null;
}

export interface SelectorState {
  configOptions?: ReadonlyArray<ConfigOption> | null;
}

export function selector(state: SelectorState | undefined, category: "model" | "thought_level"): ConfigOption | undefined {
  return state?.configOptions?.find(option => option.type === "select" &&
    (option.category === category || option.id === category ||
      (category === "thought_level" && ["thinking_level", "reasoning_effort"].includes(option.id))));
}

export function choices(option: ConfigOption | undefined): { value: string; name: string }[] {
  return (option?.options ?? []).flatMap(entry => Array.isArray(entry.options) ? entry.options : [entry])
    .filter((entry): entry is { value: string; name: string } => validId(entry.value) && typeof entry.name === "string");
}

export function advertisedRecord(state: SelectorState | undefined, modelId: string, name: string): AdvertisedModel {
  const thought = selector(state, "thought_level");
  return {
    modelId, name, selector: true,
    ...(thought ? { thoughtLevels: choices(thought).map(option => option.value), ...(typeof thought.currentValue === "string" ? { defaultThoughtLevel: thought.currentValue } : {}) } : {}),
  };
}

export function resolveSelection(state: SelectorState | undefined, requested: string): { modelId: string; effort?: string } {
  const values = choices(selector(state, "model")).map(option => option.value);
  // An exact server ID takes precedence over any local suffix interpretation.
  if (values.includes(requested)) return { modelId: requested };
  const local = parseThoughtRoute(requested);
  if (local) {
    if (!values.includes(local.modelId)) throw new Error(`ACP no longer advertises model ${local.modelId}`);
    return local;
  }
  const legacy = splitLegacyEffort(requested);
  if (legacy && values.includes(legacy.base)) return { modelId: legacy.base, effort: legacy.effort };
  return { modelId: requested };
}
