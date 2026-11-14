import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./fs-atomic.ts";

export type AdapterPermissionMode = "default" | "auto_edit" | "yolo" | "follow";
export type EffectivePermissionMode = Exclude<AdapterPermissionMode, "follow">;
export type OmpApprovalMode = "always-ask" | "always-ask-cached" | "write" | "yolo";
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
  permissions: "follow",
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
  return parseAdapterConfig(parsed, seed);
}

function parseAdapterConfig(parsed: unknown, seed: AdapterConfigSeed): AdapterConfig {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return seeded(seed);
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
    permissions: record.permissions === "default" || record.permissions === "auto_edit"
      || record.permissions === "yolo" || record.permissions === "follow"
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
  const merged = { ...raw, ...patch };
  const config = parseAdapterConfig(merged, {});
  writeJsonAtomic(file, {
    ...merged,
    permissions: config.permissions,
    runtimeUpdates: config.runtimeUpdates,
    runtimeSource: config.runtimeSource,
    nativeTools: config.nativeTools,
    debugToolUpdates: config.debugToolUpdates,
    usageMode: config.usageMode,
    diagnostics: config.diagnostics,
  });
  return config;
}

export function saveAdapterPermissionMode(mode: AdapterPermissionMode, file: string): void {
  updateAdapterConfig(file, { permissions: mode });
}

export function loadRuntimeSourcePreference(stateDir: string): RuntimeSourcePreference {
  return loadAdapterConfig(path.join(stateDir, "config.json")).runtimeSource;
}

const OMP_APPROVAL_MODES = new Set<OmpApprovalMode>(["always-ask", "always-ask-cached", "write", "yolo"]);

function yamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0]!;
    const end = trimmed.lastIndexOf(quote);
    if (end > 0) return trimmed.slice(1, end);
  }
  return trimmed.replace(/\s+#.*$/u, "").trim();
}

function approvalModeValue(value: string): OmpApprovalMode | undefined {
  const parsed = yamlScalar(value);
  return OMP_APPROVAL_MODES.has(parsed as OmpApprovalMode) ? parsed as OmpApprovalMode : undefined;
}

// OMP settings are YAML. Only `tools.approvalMode` is needed here, so a full
// YAML parser would add weight for one scalar. Nested keys at a deeper indent
// are ignored, and an unreadable or unknown value falls back to default.
function readApprovalMode(file: string): OmpApprovalMode | undefined {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return undefined; }
  let inTools = false;
  let childIndent: number | undefined;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 0) {
      inTools = /^tools\s*:\s*(?:#.*)?$/u.test(body);
      childIndent = undefined;
      const inline = /^tools\s*:\s*\{(.*)\}\s*$/u.exec(body);
      if (inline) {
        for (const part of inline[1]!.split(",")) {
          const match = /^\s*approvalMode\s*:\s*(.+?)\s*$/u.exec(part);
          if (match) return approvalModeValue(match[1]!);
        }
      }
      const dotted = /^tools\.approvalMode\s*:\s*(.+)$/u.exec(body);
      if (dotted) return approvalModeValue(dotted[1]!);
      continue;
    }
    if (!inTools) continue;
    if (childIndent === undefined) childIndent = indent;
    if (indent < childIndent) { inTools = false; continue; }
    if (indent !== childIndent) continue;
    const match = /^approvalMode\s*:\s*(.+)$/u.exec(body);
    if (match) return approvalModeValue(match[1]!);
  }
  return undefined;
}

function approvalModeArg(argv: readonly string[]): OmpApprovalMode | undefined {
  if (argv.includes("--auto-approve")) return "yolo";
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const value = arg === "--approval-mode" ? argv[index + 1]
      : arg.startsWith("--approval-mode=") ? arg.slice("--approval-mode=".length) : undefined;
    if (value !== undefined) return OMP_APPROVAL_MODES.has(value as OmpApprovalMode) ? value as OmpApprovalMode : undefined;
  }
  return undefined;
}

/** Project-local OMP settings override the global agent config. */
export function readOmpApprovalMode(
  agentDir: string,
  cwd = process.cwd(),
  argv: readonly string[] = process.argv,
): OmpApprovalMode | undefined {
  const override = approvalModeArg(argv);
  if (override) return override;
  let mode: OmpApprovalMode | undefined;
  for (const file of [
    path.join(agentDir, "config.yml"),
    path.join(agentDir, "config.yaml"),
    path.join(cwd, ".omp", "config.yml"),
    path.join(cwd, ".omp", "config.yaml"),
  ]) {
    const next = readApprovalMode(file);
    if (next) mode = next;
  }
  return mode;
}

export function resolveAdapterPermissionMode(
  preference: AdapterPermissionMode,
  agentDir: string,
  cwd = process.cwd(),
): EffectivePermissionMode {
  if (preference !== "follow") return preference;
  switch (readOmpApprovalMode(agentDir, cwd)) {
    case "yolo": return "yolo";
    case "write": return "auto_edit";
    default: return "default";
  }
}
