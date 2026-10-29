import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { inspectAntigravityAuth } from "./acp/antigravity.js";
import { ensureAntigravityAcpReady, inspectRuntimeSetup } from "./acp/setup.js";
import { MANAGED_AUTH_MARKER } from "./constants.js";
import { savePermissionMode, type PermissionMode } from "./config.js";
import type { AntigravityRuntime } from "./runtime.js";

export async function runSetupWizard(
	ui: ExtensionUIContext,
	runtime: AntigravityRuntime,
): Promise<void> {
	ui.notify("Checking Antigravity ACP runtime…", "info");
	await ensureAntigravityAcpReady((message) => ui.notify(message, "info"));
	const setup = inspectRuntimeSetup();
	let localAuth = inspectAntigravityAuth();
	if (localAuth.status !== "oauth-refreshable" && localAuth.status !== "api-key-env") {
		const loginNow = await ui.confirm(
			"Antigravity authentication",
			"Sign in with Google now? Choose No to use Pi's /login API-key flow later.",
		);
		if (!loginNow) {
			ui.notify(
				`Runtime ${setup.installedVersion ?? setup.approvedVersion} ready at ${setup.launch?.command ?? "unknown path"}. Run /login and choose Google Antigravity (ACP) when ready.`,
				"warning",
			);
			return;
		}
		await runtime.loginGoogle(
			undefined,
			(message) => ui.notify(message, "info"),
			{
				showAuthorizationUrl: (url, instructions) => ui.notify(`${instructions}\n${url}`, "info"),
				promptForCallback: async (signal) => {
					const value = await ui.input(
						"Paste the final localhost callback URL (or authorization code)",
						"http://127.0.0.1:PORT/?state=…&code=…",
						{ signal },
					);
					if (!value) throw new Error("Antigravity OAuth login cancelled");
					return value;
				},
			},
		);
		localAuth = inspectAntigravityAuth();
	}

	const selectedMode = await ui.select("Default Antigravity permission mode", [
		"yolo — run commands and edits without confirmation",
		"auto-edit — allow edits; ask for commands",
		"default — ask before sensitive operations",
	]);
	if (selectedMode) {
		const mode = selectedMode.startsWith("auto-edit")
			? "auto_edit"
			: (selectedMode.split(" ", 1)[0] as PermissionMode);
		await runtime.setPermissionMode(mode);
		savePermissionMode(mode);
	}

	ui.notify("Validating authentication and discovering models…", "info");
	const health = await runtime.authHealth(
		localAuth.status === "api-key-env" ? process.env.GEMINI_API_KEY : MANAGED_AUTH_MARKER,
	);
	if (!health.networkValid) {
		ui.notify(`Antigravity authentication probe failed: ${health.error ?? "unknown error"}`, "error");
		return;
	}
	const models = await runtime.discoverModels(
		localAuth.status === "api-key-env" ? process.env.GEMINI_API_KEY : MANAGED_AUTH_MARKER,
	);
	const runtimeStatus = await runtime.snapshot();
	ui.notify(
		[
			"Antigravity ACP setup complete.",
			`Runtime: ${setup.installedVersion ?? setup.approvedVersion} (${setup.platform})`,
			`Authentication: valid ${localAuth.authType ?? localAuth.status}`,
			`Models discovered: ${models.length}`,
			`Permission mode: ${runtimeStatus.permissionMode.replace("_", "-")}.`,
		].join("\n"),
		"info",
	);
}
