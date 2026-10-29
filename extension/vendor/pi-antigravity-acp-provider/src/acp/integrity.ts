import { createHash } from "node:crypto";
import fs from "node:fs";

import { latestManifestRelease, readBundledRuntimeManifest } from "./runtime-manifest.js";

export interface PinnedPlatformRuntime {
	archive: string;
	archiveSha256: string;
	binaryName: "agy_acp_server.par" | "agy_acp_server.exe";
	binarySha256?: string;
}

const bundledRelease = latestManifestRelease(readBundledRuntimeManifest());

/** Compatibility exports for callers that used the original single-release
 * integrity API. New installation code consumes the signed runtime manifest. */
export const PINNED_RUNTIME_VERSION = bundledRelease.version;
export const PINNED_RUNTIME: Readonly<Record<string, PinnedPlatformRuntime>> = Object.fromEntries(
	Object.entries(bundledRelease.platforms).map(([key, asset]) => [
		key,
		{
			archive: asset.archive,
			archiveSha256: asset.archiveSha256,
			binaryName: asset.binaryName,
		},
	]),
);

export function pinnedPlatform(key: string): PinnedPlatformRuntime {
	const runtime = PINNED_RUNTIME[key];
	if (!runtime) throw new Error(`No pinned Antigravity ACP ${PINNED_RUNTIME_VERSION} build for ${key}`);
	return runtime;
}

export function assertPinnedArchive(key: string, archive: string): PinnedPlatformRuntime {
	const pinned = pinnedPlatform(key);
	if (archive !== pinned.archive) {
		throw new Error(
			`ACP registry artifact differs from pinned ${PINNED_RUNTIME_VERSION} ${key} URL; refusing unreviewed runtime`,
		);
	}
	return pinned;
}

export function verifyPinnedArchive(key: string, actual: string): string {
	const expected = pinnedPlatform(key).archiveSha256;
	if (actual !== expected) throw new Error(`Antigravity ACP archive SHA-256 mismatch for ${key}`);
	return actual;
}

export async function sha256File(file: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

export async function verifyPinnedBinary(key: string, file: string): Promise<string> {
	const actual = await sha256File(file);
	const expected = pinnedPlatform(key).binarySha256;
	if (expected && actual !== expected) {
		throw new Error(`Antigravity ACP binary SHA-256 mismatch for ${key}`);
	}
	return actual;
}
