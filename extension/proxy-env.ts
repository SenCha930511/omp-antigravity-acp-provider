// The MCP bridge and relay control server bind 127.0.0.1. A user-level
// HTTP(S)_PROXY/ALL_PROXY routes that loopback traffic to an external proxy
// and hangs every tool call unless loopback is excluded, so loopback entries
// are always appended to the proxy bypass list of a proxied environment.

const PROXY_VARIABLES = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const;
const LOOPBACK_ENTRIES = ["localhost", "127.0.0.1", "::1"] as const;

export function ensureLoopbackBypass(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const proxied = PROXY_VARIABLES.some((name) => (env[name] ?? "").trim() !== "");
  if (!proxied) return env;
  const source = env.NO_PROXY ?? env.no_proxy;
  const entries: string[] = [];
  for (const part of (source ?? "").split(",")) {
    const entry = part.trim();
    if (entry !== "" && !entries.includes(entry)) entries.push(entry);
  }
  for (const entry of LOOPBACK_ENTRIES) {
    if (!entries.includes(entry)) entries.push(entry);
  }
  const merged = entries.join(",");
  return { ...env, NO_PROXY: merged, no_proxy: merged };
}
