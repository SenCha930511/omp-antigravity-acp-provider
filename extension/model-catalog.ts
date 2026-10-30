// Public OMP models are derived only from server-advertised IDs and choices.
import { EFFORTS, splitLegacyEffort } from "./efforts.ts";
export { EFFORTS, splitLegacyEffort };
export interface AdvertisedModel {
  modelId: string;
  name: string;
  selector?: boolean;
  thoughtLevels?: string[];
  defaultThoughtLevel?: string;
}
export interface PublicCatalogModel {
  id: string;
  name: string;
  api: "antigravity-acp";
  provider: "antigravity-acp";
  baseUrl?: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  thinkingLevelMap?: Record<string, string | null>;
  thinking?: { mode: "effort"; efforts: string[]; defaultLevel?: string };
}
const ROUTE_PREFIX = "__omp_acp_thought__:";
// The legacy "<base>-<effort>" suffix lives in efforts.ts so pricing agrees.
export function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function readModels(value: unknown): AdvertisedModel[] {
  if (!Array.isArray(value) || value.length > 2048) return [];
  return value.filter((model): model is AdvertisedModel => Boolean(model) && typeof model === "object" && validId(model.modelId) &&
    typeof model.name === "string" && model.name.length <= 512 &&
    (model.selector === undefined || typeof model.selector === "boolean") &&
    (model.thoughtLevels === undefined || (Array.isArray(model.thoughtLevels) &&
      model.thoughtLevels.length <= 64 && model.thoughtLevels.every(validId))) &&
    (model.defaultThoughtLevel === undefined || validId(model.defaultThoughtLevel)));
}

export function thoughtRoute(modelId: string, effort: string): string {
  return ROUTE_PREFIX + Buffer.from(JSON.stringify({ modelId, effort })).toString("base64url");
}

export function parseThoughtRoute(value: string): { modelId: string; effort: string } | undefined {
  if (!value.startsWith(ROUTE_PREFIX)) return undefined;
  try {
    const route = JSON.parse(Buffer.from(value.slice(ROUTE_PREFIX.length), "base64url").toString());
    if (validId(route.modelId) && validId(route.effort)) return route;
  } catch { /* Fall through to the explicit protocol error. */ }
  throw new Error("Invalid local ACP thought selector route");
}

function publicModel(id: string, name: string, map: Record<string, string> = {}, current?: string): PublicCatalogModel {
  const efforts = EFFORTS.filter(effort => map[effort]);
  const knownGemini = id === "gemini-4-argon" || id === "gemini-3.8-flash";
  const defaultLevel = current && (efforts as readonly string[]).includes(current) ? current
    : efforts.includes("high") ? "high" : efforts.includes("medium") ? "medium" : efforts[0];
  return {
    id, name, api: "antigravity-acp", provider: "antigravity-acp", baseUrl: "",
    reasoning: efforts.length > 0, input: ["text", "image"],
    // These are conservative client metadata defaults, not inferred server limits.
    contextWindow: knownGemini ? 1_000_000 : 32_768,
    maxTokens: knownGemini ? 65_536 : 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(efforts.length ? {
      thinkingLevelMap: Object.fromEntries(EFFORTS.map(effort => [effort, map[effort] ?? null])),
      thinking: { mode: "effort", efforts, defaultLevel },
    } : {}),
  };
}

export function projectCatalog(value: unknown): PublicCatalogModel[] {
  const records = readModels(value);
  const groups = new Map<string, { name: string; map: Record<string, string>; count: number }>();
  for (const record of records) {
    if (record.selector) continue;
    const legacy = splitLegacyEffort(record.modelId);
    if (!legacy) continue;
    const group = groups.get(legacy.base) ?? { name: record.name.replace(/\s*\((?:off|minimal|low|medium|high|xhigh|max)\)\s*$/i, ""), map: {}, count: 0 };
    group.map[legacy.effort] = record.modelId;
    group.count = Object.keys(group.map).length;
    groups.set(legacy.base, group);
  }
  const emitted = new Set<string>();
  const models: PublicCatalogModel[] = [];
  for (const record of records) {
    if (record.selector) {
      if (emitted.has(record.modelId)) continue;
      const map = Object.fromEntries((record.thoughtLevels ?? [])
        .filter(level => (EFFORTS as readonly string[]).includes(level))
        .map(level => [level, thoughtRoute(record.modelId, level)]));
      models.push(publicModel(record.modelId, record.name || record.modelId, map, record.defaultThoughtLevel));
      emitted.add(record.modelId);
      continue;
    }
    const legacy = splitLegacyEffort(record.modelId);
    const group = legacy ? groups.get(legacy.base) : groups.get(record.modelId);
    const id = group && group.count > 1 && legacy ? legacy.base : record.modelId;
    if (emitted.has(id)) continue;
    models.push(publicModel(id, group?.name || record.name || id, group?.map));
    emitted.add(id);
  }
  return models;
}

export function selectRuntimeModel<T extends PublicCatalogModel>(model: T, requested?: string): T {
  const map = model.thinkingLevelMap;
  if (!model.reasoning || !map) return model;
  const available = EFFORTS.filter(effort => typeof map[effort] === "string");
  const preference = requested && (EFFORTS as readonly string[]).includes(requested)
    ? requested : model.thinking?.defaultLevel ?? "medium";
  const targetIndex = (EFFORTS as readonly string[]).indexOf(preference);
  const selected = [...available].sort((a, b) =>
    Math.abs(EFFORTS.indexOf(a) - targetIndex) - Math.abs(EFFORTS.indexOf(b) - targetIndex))[0];
  const route = map[preference] ?? (selected ? map[selected] : undefined);
  if (!route) throw new Error(`No advertised ACP thinking choice for ${model.id}`);
  // Upstream 0.1.15 resolves through three effort buckets. Pin all buckets to
  // the exact selected route so off/minimal/xhigh/max are not clamped to high.
  return { ...model, thinkingLevelMap: { low: route, medium: route, high: route } };
}
