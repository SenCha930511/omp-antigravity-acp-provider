import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./fs-atomic.ts";

export type AdapterPermissionMode = "default" | "auto_edit" | "yolo";
export type AdapterRuntimeUpdateMode = "automatic" | "notify" | "manual";
export type RuntimeSourcePreference = "auto" | "cli" | "managed";
export type AdapterUsageMode = "auto" | "off";
export type AdapterNativeToolMode = "prefer" | "disabled";

export interface AdapterConfig {
  permissions: AdapterPermissionMode;
  runtimeUpdates: AdapterRuntimeUpdateMode;
  runtimeSource: RuntimeSourcePreference;
  nativeTools: AdapterNativeToolMode;
  debugToolUpdates: boolean;
  usageMode: AdapterUsageMode;
  diagnostics: boolean;
}

export interface AdapterConfigSeed {
  nativeTools?: AdapterNativeToolMode;
  debugToolUpdates?: boolean;
  usageMode?: AdapterUsageMode;
  diagnostics?: boolean;
}

const DEFAULTS: AdapterConfig = {
  permissions: "yolo",
  runtimeUpdates: "automatic",
  runtimeSource: "auto",
  nativeTools: "prefer",
  debugToolUpdates: false,
  usageMode: "off",
  diagnostics: false,
};

function seeded(seed: AdapterConfigSeed): AdapterConfig {
  return {
    ...DEFAULTS,
    nativeTools: seed.nativeTools ?? DEFAULTS.nativeTools,
    debugToolUpdates: seed.debugToolUpdates ?? DEFAULTS.debugToolUpdates,
    usageMode: seed.usageMode ?? DEFAULTS.usageMode,
    diagnostics: seed.diagnostics ?? DEFAULTS.diagnostics,
  };
}

export function loadAdapterConfig(file: string, seed: AdapterConfigSeed = {}): AdapterConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return seeded(seed);
  }
  if (!parsed || typeof parsed !== "object") return seeded(seed);
  const record = parsed as Record<string, unknown>;
  const runtimeSource = record.runtimeSource;
  if (runtimeSource !== undefined && runtimeSource !== "auto" && runtimeSource !== "cli" && runtimeSource !== "managed") {
    throw new Error('runtimeSource must be "auto", "cli", or "managed"');
  }
  if (record.nativeTools !== undefined && record.nativeTools !== "prefer" && record.nativeTools !== "disabled") {
    throw new Error("nativeTools must be prefer or disabled");
  }
  if (record.debugToolUpdates !== undefined && typeof record.debugToolUpdates !== "boolean") {
    throw new Error("debugToolUpdates must be boolean");
  }
  if (record.usageMode !== undefined && record.usageMode !== "auto" && record.usageMode !== "off") {
    throw new Error("usageMode must be auto or off");
  }
  if (record.diagnostics !== undefined && typeof record.diagnostics !== "boolean") {
    throw new Error("diagnostics must be boolean");
  }
  return {
    permissions: record.permissions === "default" || record.permissions === "auto_edit" || record.permissions === "yolo"
      ? record.permissions : DEFAULTS.permissions,
    runtimeUpdates: record.runtimeUpdates === "automatic" || record.runtimeUpdates === "notify" || record.runtimeUpdates === "manual"
      ? record.runtimeUpdates : DEFAULTS.runtimeUpdates,
    runtimeSource: runtimeSource ?? DEFAULTS.runtimeSource,
    nativeTools: record.nativeTools ?? seed.nativeTools ?? DEFAULTS.nativeTools,
    debugToolUpdates: record.debugToolUpdates ?? seed.debugToolUpdates ?? DEFAULTS.debugToolUpdates,
    usageMode: record.usageMode ?? seed.usageMode ?? DEFAULTS.usageMode,
    diagnostics: record.diagnostics ?? seed.diagnostics ?? DEFAULTS.diagnostics,
  };
}

export function updateAdapterConfig(file: string, patch: Partial<AdapterConfig>): AdapterConfig {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    // A missing or malformed file starts from an empty object.
  }
  writeJsonAtomic(file, { ...raw, ...patch });
  return loadAdapterConfig(file);
}

export function saveAdapterPermissionMode(mode: AdapterPermissionMode, file: string): void {
  updateAdapterConfig(file, { permissions: mode });
}

export function loadRuntimeSourcePreference(stateDir: string): RuntimeSourcePreference {
  return loadAdapterConfig(path.join(stateDir, "config.json")).runtimeSource;
}
