import packageJson from "../../package.json" with { type: "json" };

export const PACKAGE_VERSION = packageJson.version;
export const ANTIGRAVITY_ACP_VERSION = "1.1.1";
export const ACP_SDK_VERSION = "1.8.0";
export const ACP_PROTOCOL_VERSION = 1;
export const MANAGED_AUTH_MARKER = "pi-antigravity-acp:managed-by-antigravity";

// The managed marker is an OMP-local placeholder that keeps the provider
// visible after logout; it is not a secret and must never authorize a request
// by itself. A real request credential is a non-empty trimmed value.
export function usableApiKey(apiKey: string | undefined): string | undefined {
  const trimmed = apiKey?.trim();
  return trimmed && trimmed !== MANAGED_AUTH_MARKER ? trimmed : undefined;
}
export const PERMISSION_TOOL_NAME = "antigravity_acp_permission";
export const PERMISSION_RESULT_KIND = "pi-antigravity-acp-permission-v1";
export const BRIDGED_TOOL_RESULT_KIND = "pi-antigravity-acp-tool-v1";
