import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CAPTURE_ENV = "PI_ANTIGRAVITY_OAUTH_CAPTURE_FILE";
const CAPTURE_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 64 * 1024;

export interface CapturedOAuthAuthorization {
	url: string;
	redirectUrl: URL;
	state: string;
}

/** ACP 1.1.1 does not surface its OAuth URL. On a remote/headless host we
 * replace the browser command with a private capture helper, display the URL
 * through Pi, and relay the browser's final loopback callback locally. */
export class HeadlessOAuthRelay {
	readonly env: NodeJS.ProcessEnv;
	private readonly directory: string;
	private readonly captureFile: string;
	private disposed = false;

	constructor(baseEnv: NodeJS.ProcessEnv = process.env) {
		if (process.platform === "win32") {
			throw new Error("Manual Antigravity OAuth capture is not yet supported on Windows hosts");
		}
		this.directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-antigravity-oauth-"));
		fs.chmodSync(this.directory, 0o700);
		this.captureFile = path.join(this.directory, "authorization-url");
		const browser = path.join(this.directory, "capture-browser");
		fs.writeFileSync(
			browser,
			`#!/bin/sh\numask 077\nprintf '%s\\n' "$1" > "$${CAPTURE_ENV}"\n`,
			{ mode: 0o700 },
		);
		const executable = path.join(this.directory, "xdg-open");
		fs.copyFileSync(browser, executable);
		fs.chmodSync(executable, 0o700);
		this.env = {
			...baseEnv,
			BROWSER: browser,
			[CAPTURE_ENV]: this.captureFile,
			PATH: `${this.directory}${path.delimiter}${baseEnv.PATH ?? ""}`,
		};
	}

	async waitForAuthorization(signal?: AbortSignal): Promise<CapturedOAuthAuthorization> {
		const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
		for (;;) {
			if (this.disposed) throw new Error("Antigravity OAuth relay was closed");
			if (signal?.aborted) throw abortReason(signal);
			try {
				const stat = fs.lstatSync(this.captureFile);
				if (!stat.isFile() || stat.size > MAX_CAPTURE_BYTES) {
					throw new Error("Antigravity OAuth browser capture produced an invalid file");
				}
				const text = fs.readFileSync(this.captureFile, "utf8").trim();
				if (text) return parseAuthorization(text);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (Date.now() >= deadline) {
				throw new Error("Antigravity did not provide an OAuth URL within 30 seconds");
			}
			await delay(100, signal);
		}
	}

	async forwardCallback(
		input: string,
		authorization: CapturedOAuthAuthorization,
		signal?: AbortSignal,
	): Promise<void> {
		const callback = callbackUrl(input, authorization);
		let response: Response;
		try {
			response = await fetch(callback, {
				redirect: "manual",
				...(signal ? { signal } : {}),
			});
		} catch (cause) {
			throw new Error(
				"Could not relay the Google OAuth callback to Antigravity's loopback listener",
				{ cause },
			);
		}
		await response.body?.cancel().catch(() => undefined);
		if (response.status >= 400) {
			throw new Error(`Antigravity OAuth callback failed with HTTP ${response.status}`);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		fs.rmSync(this.directory, { recursive: true, force: true });
	}
}

export function shouldUseHeadlessOAuth(
	environment: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	const override = environment.PI_ANTIGRAVITY_ACP_OAUTH_MODE?.trim().toLowerCase();
	if (override === "manual") return true;
	if (override === "browser") return false;
	if (environment.SSH_CONNECTION || environment.SSH_CLIENT || environment.SSH_TTY) return true;
	return platform === "linux" && !environment.DISPLAY && !environment.WAYLAND_DISPLAY;
}

function parseAuthorization(text: string): CapturedOAuthAuthorization {
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new Error("Antigravity produced an invalid OAuth authorization URL");
	}
	if (
		url.protocol !== "https:" ||
		url.hostname !== "accounts.google.com" ||
		url.pathname !== "/o/oauth2/v2/auth"
	) {
		throw new Error("Antigravity produced an unexpected OAuth authorization URL");
	}
	const redirect = url.searchParams.get("redirect_uri");
	const state = url.searchParams.get("state");
	if (!redirect || !state) throw new Error("Antigravity OAuth URL is missing redirect or state data");
	const redirectUrl = new URL(redirect);
	validateLoopback(redirectUrl);
	return { url: url.toString(), redirectUrl, state };
}

function callbackUrl(input: string, authorization: CapturedOAuthAuthorization): URL {
	const value = input.trim();
	if (!value) throw new Error("Google OAuth callback URL or authorization code is required");
	let callback: URL;
	if (/^https?:\/\//iu.test(value)) {
		callback = new URL(value);
	} else {
		callback = new URL(authorization.redirectUrl);
		const params = value.includes("=") ? new URLSearchParams(value.replace(/^\?/u, "")) : undefined;
		callback.searchParams.set("code", params?.get("code") ?? value);
		callback.searchParams.set("state", params?.get("state") ?? authorization.state);
	}
	validateLoopback(callback);
	if (
		callback.origin !== authorization.redirectUrl.origin ||
		callback.pathname !== authorization.redirectUrl.pathname
	) {
		throw new Error("Google OAuth callback does not match Antigravity's loopback listener");
	}
	if (callback.searchParams.get("state") !== authorization.state) {
		throw new Error("Google OAuth callback state does not match the current login attempt");
	}
	if (!callback.searchParams.get("code") && !callback.searchParams.get("error")) {
		throw new Error("Google OAuth callback is missing an authorization code");
	}
	return callback;
}

function validateLoopback(url: URL): void {
	if (
		url.protocol !== "http:" ||
		!(url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") ||
		!url.port ||
		url.username ||
		url.password
	) {
		throw new Error("Antigravity OAuth redirect is not a valid loopback URL");
	}
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortReason(signal));
			return;
		}
		const finish = (callback: () => void) => {
			if (signal) signal.removeEventListener("abort", abort);
			callback();
		};
		const timer = setTimeout(() => finish(resolve), ms);
		timer.unref?.();
		const abort = () => {
			clearTimeout(timer);
			finish(() => reject(abortReason(signal!)));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Antigravity OAuth login cancelled");
}
