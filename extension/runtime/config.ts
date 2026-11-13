import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type PermissionMode = "default" | "auto_edit" | "yolo";
export type RuntimeUpdateMode = "automatic" | "notify" | "manual";

export interface AntigravityAcpConfig {
	permissions: PermissionMode;
	runtimeUpdates: RuntimeUpdateMode;
}

export function resolvePiAgentDir(): string {
	const custom = process.env.PI_CODING_AGENT_DIR?.trim();
	if (custom) {
		return custom === "~" || custom.startsWith("~/")
			? path.join(os.homedir(), custom.slice(1))
			: custom;
	}
	return path.join(os.homedir(), ".pi", "agent");
}

export function resolveConfigRoot(): string {
	return path.join(resolvePiAgentDir(), "antigravity-acp-provider");
}

export function resolveConfigPath(): string {
	return path.join(resolveConfigRoot(), "config.json");
}

export function resolveDefaultPiConfigPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "antigravity-acp-provider", "config.json");
}

export function resolveLegacyGeminiConfigPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "gemini-acp-provider", "config.json");
}

export const DEFAULT_CONFIG_PATH = resolveDefaultPiConfigPath();
export const LEGACY_GEMINI_CONFIG_PATH = resolveLegacyGeminiConfigPath();

export const CONFIG_PATH = resolveConfigPath();

export function loadConfig(file = resolveConfigPath()): AntigravityAcpConfig {
	if (file === resolveConfigPath()) migrateConfig(file);
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
			permissions?: unknown;
			runtimeUpdates?: unknown;
		};
		return {
			permissions: isPermissionMode(parsed.permissions) ? parsed.permissions : "yolo",
			runtimeUpdates: isRuntimeUpdateMode(parsed.runtimeUpdates) ? parsed.runtimeUpdates : "automatic",
		};
	} catch {
		// Missing or malformed configuration uses the documented defaults.
	}
	return { permissions: "yolo", runtimeUpdates: "automatic" };
}

export function savePermissionMode(mode: PermissionMode, file = resolveConfigPath()): void {
	writeConfig({ ...loadConfig(file), permissions: mode }, file);
}

export function saveRuntimeUpdateMode(mode: RuntimeUpdateMode, file = resolveConfigPath()): void {
	writeConfig({ ...loadConfig(file), runtimeUpdates: mode }, file);
}

function writeConfig(config: AntigravityAcpConfig, file: string): void {
	const directory = path.dirname(file);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
}

function migrateConfig(targetFile = resolveConfigPath()): void {
	if (fs.existsSync(targetFile)) return;

	const defaultPiConfig = resolveDefaultPiConfigPath();
	if (targetFile !== defaultPiConfig && fs.existsSync(defaultPiConfig)) {
		copyConfig(defaultPiConfig, targetFile);
		return;
	}

	const legacyGeminiConfig = resolveLegacyGeminiConfigPath();
	if (fs.existsSync(legacyGeminiConfig)) {
		copyConfig(legacyGeminiConfig, targetFile);
		return;
	}
}

function copyConfig(source: string, destination: string): void {
	try {
		fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
		fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
		fs.chmodSync(destination, 0o600);
	} catch {
		// Migration is best-effort; defaults remain available.
	}
}

export function isPermissionMode(value: unknown): value is PermissionMode {
	return value === "default" || value === "auto_edit" || value === "yolo";
}

export function isRuntimeUpdateMode(value: unknown): value is RuntimeUpdateMode {
	return value === "automatic" || value === "notify" || value === "manual";
}

export function permissionModeLabel(mode: PermissionMode): string {
	if (mode === "auto_edit") return "auto-edit";
	return mode;
}
