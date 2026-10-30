import fs from "node:fs";
import { isMissingFileError, writeJsonAtomic } from "./fs-atomic.ts";
export interface ContextOptions {
  contextWindow?: number;
  maxTokens?: number;
  inputTokenBudget?: number;
  reserveTokens?: number;
  maxTransferBytes?: number;
  maxImageBytes?: number;
}
export interface ContextSettings {
  defaults: ContextOptions & { usageMode?: "auto" | "off" };
  models: Record<string, ContextOptions>;
}
const ranges: Record<keyof ContextOptions, [number, number]> = {
  contextWindow: [4096, 16_777_216], maxTokens: [1, 1_048_576], inputTokenBudget: [1, 16_777_216],
  reserveTokens: [0, 1_048_576], maxTransferBytes: [65_536, 134_217_728], maxImageBytes: [0, 100_663_296],
};
function validate(options: unknown, allowUsage: boolean): void {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Context settings must be an object");
  for (const [key, value] of Object.entries(options)) {
    if (key === "usageMode" && allowUsage) {
      if (value !== "auto" && value !== "off") throw new Error("usageMode must be auto or off");
      continue;
    }
    const range = Object.hasOwn(ranges, key) ? ranges[key as keyof ContextOptions] : undefined;
    if (!range || !Number.isSafeInteger(value) || (value as number) < range[0] || (value as number) > range[1]) {
      throw new Error(`Invalid context setting ${key}${range ? `; expected ${range[0]}..${range[1]}` : ""}`);
    }
  }
}
export function loadContextSettings(file: string): ContextSettings {
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error: unknown) { if (isMissingFileError(error)) return { defaults: {}, models: {} }; throw error; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some(key => !["defaults", "models"].includes(key))) {
    throw new Error("Invalid context settings file");
  }
  const settings = parsed as { defaults?: ContextSettings["defaults"]; models?: Record<string, ContextOptions> };
  const defaults = settings.defaults ?? {}, models = settings.models ?? {};
  validate(defaults, true);
  if (!models || typeof models !== "object" || Array.isArray(models)) throw new Error("models must be an object");
  for (const [id, options] of Object.entries(models)) {
    if (!id || ["__proto__", "constructor", "prototype"].includes(id)) throw new Error("Invalid model ID");
    validate(options, false);
  }
  return { defaults, models };
}
export function saveContextSettings(file: string, settings: ContextSettings) {
  validate(settings.defaults, true);
  for (const options of Object.values(settings.models)) validate(options, false);
  writeJsonAtomic(file, settings);
}
export function updateContextSettings(settings: ContextSettings, target: string, key: string, value: number | string): ContextSettings {
  if (["__proto__", "constructor", "prototype"].includes(target)) throw new Error("Invalid model ID");
  const next = structuredClone(settings);
  const options: Record<string, unknown> = target === "default" ? next.defaults
    : Object.hasOwn(next.models, target) ? next.models[target]! : (next.models[target] = {});
  options[key] = value;
  validate(options, target === "default");
  return next;
}

export interface ResolvedContextOptions {
  contextWindow: number;
  maxTokens: number;
  reserveTokens: number;
  inputTokenBudget: number;
  maxTransferBytes: number;
  maxImageBytes: number;
}

export function resolveContextOptions(model: { id: string; contextWindow: number; maxTokens: number }, settings: ContextSettings): ResolvedContextOptions {
  const options = { ...settings.defaults, ...settings.models[model.id] };
  const contextWindow = options.contextWindow ?? model.contextWindow;
  const maxTokens = options.maxTokens ?? model.maxTokens;
  const reserveTokens = options.reserveTokens ?? Math.min(16_384, Math.floor(contextWindow * 0.05));
  const automatic = contextWindow - maxTokens - reserveTokens;
  const inputTokenBudget = options.inputTokenBudget ?? automatic;
  if (automatic <= 0 || inputTokenBudget > automatic) throw new Error(`Invalid token budgets for ${model.id}: input + output + reserve must fit contextWindow`);
  return { contextWindow, maxTokens, reserveTokens, inputTokenBudget,
    maxTransferBytes: options.maxTransferBytes ?? 16_777_216,
    maxImageBytes: options.maxImageBytes ?? 8_388_608 };
}

// Lightweight estimate, not a Gemini tokenizer. Do not download tokenizers or
// confuse payload bytes with tokens. Non-ASCII receives a larger allowance.
export function estimateTransferTokens(text: string, images = 0, utf8Bytes = Buffer.byteLength(text, "utf8")) {
  const nonAscii = Math.min(text.length, Math.ceil((utf8Bytes - text.length) / 2));
  return Math.ceil((text.length - nonAscii) / 3 + nonAscii * 1.5) + images * 4096;
}
