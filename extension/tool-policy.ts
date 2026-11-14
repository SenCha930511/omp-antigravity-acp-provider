import fs from "node:fs";
import { errorMessageOf, isMissingFileError, writeJsonAtomic } from "./fs-atomic.ts";
import { parseNativeToolMode, type NativeToolMode } from "./tool-routing.ts";
export function loadNativeToolMode(file: string): NativeToolMode {
  return loadToolPolicy(file).nativeTools;
}

export interface ToolPolicy { nativeTools: NativeToolMode; debugToolUpdates: boolean }

export function loadToolPolicy(file: string): ToolPolicy {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || Array.isArray(data) || typeof data !== "object") throw new Error("expected a policy object");
    const record = data as { nativeTools?: unknown; debugToolUpdates?: unknown };
    if (record.debugToolUpdates !== undefined && typeof record.debugToolUpdates !== "boolean") {
      throw new Error("debugToolUpdates must be boolean");
    }
    return {
      nativeTools: parseNativeToolMode(record.nativeTools === undefined ? "disabled" : String(record.nativeTools)),
      debugToolUpdates: record.debugToolUpdates ?? false,
    };
  } catch (error: unknown) {
    if (isMissingFileError(error)) return { nativeTools: "disabled", debugToolUpdates: false };
    throw new Error(`Invalid OMP ACP tool policy: ${errorMessageOf(error)}`);
  }
}

export function saveNativeToolMode(file: string, mode: NativeToolMode) {
  parseNativeToolMode(mode);
  saveToolPolicy(file, { ...loadToolPolicy(file), nativeTools: mode });
}

export function saveDebugToolUpdates(file: string, enabled: boolean) {
  if (typeof enabled !== "boolean") throw new Error("debugToolUpdates must be boolean");
  saveToolPolicy(file, { ...loadToolPolicy(file), debugToolUpdates: enabled });
}

export function saveToolPolicy(file: string, policy: ToolPolicy) {
  parseNativeToolMode(policy.nativeTools);
  if (typeof policy.debugToolUpdates !== "boolean") throw new Error("debugToolUpdates must be boolean");
  writeJsonAtomic(file, policy);
}
