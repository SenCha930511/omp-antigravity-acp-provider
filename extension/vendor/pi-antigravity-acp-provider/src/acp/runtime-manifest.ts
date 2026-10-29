import { verify } from "node:crypto";
import fs from "node:fs";

const MANIFEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAxmka3YjT7PpPic+rroqg9bhFbSmh79ZtMwlpGlwCDLA=
-----END PUBLIC KEY-----`;

export const RUNTIME_MANIFEST_URL =
	"https://raw.githubusercontent.com/zacbemis/pi-antigravity-acp-provider/main/runtime-manifest.json";
export const BUNDLED_RUNTIME_MANIFEST = new URL("../../runtime-manifest.json", import.meta.url);

export interface RuntimeReleaseAsset {
	archive: string;
	archiveSha256: string;
	archiveBytes: number;
	binaryName: "agy_acp_server.par" | "agy_acp_server.exe";
	binaryBytes: number;
	harnessName: "localharness_external" | "localharness_external.exe";
	harnessBytes: number;
	args: string[];
}

export interface RuntimeRelease {
	version: string;
	platforms: Record<string, RuntimeReleaseAsset>;
}

export interface TrustedRuntimeManifest {
	schemaVersion: 1;
	generatedAt: string;
	releases: RuntimeRelease[];
	signature: string;
}

export function readBundledRuntimeManifest(): TrustedRuntimeManifest {
	return parseTrustedRuntimeManifest(fs.readFileSync(BUNDLED_RUNTIME_MANIFEST, "utf8"));
}

export function parseTrustedRuntimeManifest(text: string): TrustedRuntimeManifest {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (cause) {
		throw new Error("Antigravity runtime manifest is malformed JSON", { cause });
	}
	if (!value || typeof value !== "object") throw new Error("Antigravity runtime manifest is invalid");
	const candidate = value as Partial<TrustedRuntimeManifest>;
	if (
		candidate.schemaVersion !== 1 ||
		typeof candidate.generatedAt !== "string" ||
		!Array.isArray(candidate.releases) ||
		candidate.releases.length === 0 ||
		candidate.releases.length > 32 ||
		typeof candidate.signature !== "string" ||
		!candidate.signature
	) {
		throw new Error("Antigravity runtime manifest has an invalid envelope");
	}
	const payload = {
		schemaVersion: candidate.schemaVersion,
		generatedAt: candidate.generatedAt,
		releases: candidate.releases,
	};
	if (
		!verify(
			null,
			Buffer.from(canonicalJson(payload)),
			MANIFEST_PUBLIC_KEY,
			Buffer.from(candidate.signature, "base64"),
		)
	) {
		throw new Error("Antigravity runtime manifest signature is invalid");
	}
	validateRuntimeReleases(payload.releases);
	return candidate as TrustedRuntimeManifest;
}

export function latestManifestRelease(manifest: TrustedRuntimeManifest): RuntimeRelease {
	return [...manifest.releases].sort((left, right) => compareRuntimeVersions(right.version, left.version))[0]!;
}

export function compareRuntimeVersions(left: string, right: string): number {
	const leftParts = versionParts(left);
	const rightParts = versionParts(right);
	for (let index = 0; index < 3; index++) {
		const difference = leftParts[index]! - rightParts[index]!;
		if (difference !== 0) return Math.sign(difference);
	}
	return 0;
}

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function isRuntimePlatform(platform: string): boolean {
	return /^(darwin|linux|windows)-(aarch64|x86_64)$/u.test(platform);
}

export function validateRuntimeReleases(releases: RuntimeRelease[]): void {
	const versions = new Set<string>();
	for (const release of releases) {
		if (!release || typeof release !== "object") throw new Error("Runtime release entry is invalid");
		versionParts(release.version);
		if (versions.has(release.version)) throw new Error("Runtime manifest contains a duplicate version");
		versions.add(release.version);
		if (!release.platforms || typeof release.platforms !== "object") {
			throw new Error("Runtime release platforms are missing");
		}
		for (const [platform, asset] of Object.entries(release.platforms)) validateAsset(platform, release.version, asset);
	}
}

function validateAsset(platform: string, version: string, asset: RuntimeReleaseAsset): void {
	if (!isRuntimePlatform(platform)) {
		throw new Error(`Runtime manifest platform is invalid: ${platform}`);
	}
	if (!asset || typeof asset !== "object") throw new Error(`Runtime manifest asset is invalid: ${platform}`);
	const expectedBinary = platform.startsWith("windows-") ? "agy_acp_server.exe" : "agy_acp_server.par";
	const expectedHarness = platform.startsWith("windows-") ? "localharness_external.exe" : "localharness_external";
	if (asset.binaryName !== expectedBinary || asset.harnessName !== expectedHarness) {
		throw new Error(`Runtime manifest executable names are invalid: ${platform}`);
	}
	validateGoogleArchiveUrl(asset.archive, version);
	if (!/^[a-f0-9]{64}$/u.test(asset.archiveSha256)) throw new Error(`Runtime manifest hash is invalid: ${platform}`);
	for (const size of [asset.archiveBytes, asset.binaryBytes, asset.harnessBytes]) {
		if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`Runtime manifest size is invalid: ${platform}`);
	}
	if (!Array.isArray(asset.args) || asset.args.some((argument) => typeof argument !== "string")) {
		throw new Error(`Runtime manifest arguments are invalid: ${platform}`);
	}
}

export function validateGoogleArchiveUrl(value: string, version: string): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Runtime manifest archive URL is invalid");
	}
	if (
		url.protocol !== "https:" ||
		url.hostname !== "dl.google.com" ||
		url.username ||
		url.password ||
		url.port ||
		!url.pathname.startsWith("/agy-extensions/releases/") ||
		url.search ||
		url.hash
	) {
		throw new Error("Runtime manifest archive is not a trusted Google release URL");
	}
	if (!archiveNameMatchesVersion(url.pathname.split("/").at(-1) ?? "", version)) {
		throw new Error("Runtime manifest archive version does not match its release");
	}
}

// Google has shipped both "agy-acp-server-agy_acp_server_1.1.1-linux-x86_64.zip"
// and "agy-acp-server-1.2.1-linux-x86_64.zip", so match the version as a whole
// "-" or "_" delimited token rather than one exact naming scheme.
export function archiveNameMatchesVersion(fileName: string, version: string): boolean {
	versionParts(version);
	const token = version.replaceAll(".", "\\.");
	return new RegExp(`(?:^|[-_])${token}(?:[-_]|\\.zip$)`, "u").test(fileName);
}

function versionParts(value: string): [number, number, number] {
	const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
	if (!match) throw new Error(`Invalid Antigravity ACP version: ${value}`);
	const parts = match.slice(1).map(Number) as [number, number, number];
	if (parts.some((part) => !Number.isSafeInteger(part))) {
		throw new Error(`Invalid Antigravity ACP version: ${value}`);
	}
	return parts;
}
