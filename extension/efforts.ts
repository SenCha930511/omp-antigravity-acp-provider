// Single source for the "<base>-<effort>" advertised ID suffix. Both the
// catalog projection and API cost lookup must agree, or pricing silently
// misses the variants the catalog advertises.
export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const LEGACY_EFFORT_SUFFIX = new RegExp(`^(.+)-(${EFFORTS.join("|")})$`);

export function splitLegacyEffort(modelId: string): { base: string; effort: string } | undefined {
  const match = modelId.match(LEGACY_EFFORT_SUFFIX);
  return match ? { base: match[1]!, effort: match[2]! } : undefined;
}
