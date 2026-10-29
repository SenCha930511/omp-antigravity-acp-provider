import { execFileSync } from "node:child_process";

/** Keep authenticated loopback MCP traffic local. The official macOS Python
 * runtime may otherwise select a system SOCKS proxy without python-socks.
 * Inspired by xztsummer/omp-antigravity-acp-provider's child-only proxy adapter. */
export function applyAcpProxyEnvironment(
	env: NodeJS.ProcessEnv,
	platform = process.platform,
	readSystemProxy: () => string = () => execFileSync("/usr/sbin/scutil", ["--proxy"], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"],
	}),
): NodeJS.ProcessEnv {
	const result = { ...env };
	const explicit = env.PI_ANTIGRAVITY_ACP_PROXY?.trim();
	if (explicit) {
		try {
			const url = new URL(explicit);
			if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error();
		} catch {
			// Never echo proxy URLs: they may contain credentials.
			throw new Error("PI_ANTIGRAVITY_ACP_PROXY must be an absolute HTTP or HTTPS proxy URL; SOCKS is not supported by the bundled runtime");
		}
		setProxy(result, explicit);
	} else if (platform === "darwin" && !PROXY_KEYS.some((key) => env[key])) {
		try {
			const settings = readSystemProxy();
			const field = (key: string) => settings.match(new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, "m"))?.[1];
			for (const kind of ["HTTPS", "HTTP"]) {
				if (field(`${kind}Enable`) !== "1") continue;
				const host = field(`${kind}Proxy`);
				const port = Number(field(`${kind}Port`));
				if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue;
				const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
				setProxy(result, new URL(`http://${address}:${port}`).toString());
				break;
			}
		} catch {
			// System proxy probing is advisory; never prevent startup if unavailable.
		}
	}
	// Add bypasses even without explicit proxy variables: OS proxy discovery is
	// independent of those variables. Preserve both existing bypass lists.
	const bypass = [...new Set([
		...(result.NO_PROXY ?? "").split(","), ...(result.no_proxy ?? "").split(","),
		"localhost", "127.0.0.1", "::1",
	].map((entry) => entry.trim()).filter(Boolean))].join(",");
	result.NO_PROXY = result.no_proxy = bypass;
	return result;
}

const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
function setProxy(env: NodeJS.ProcessEnv, url: string): void {
	for (const key of PROXY_KEYS) env[key] = url;
}
