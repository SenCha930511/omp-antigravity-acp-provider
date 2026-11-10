export type NativeToolMode = "prefer" | "disabled";

export const TOOL_ROUTING =
  "Supplied OMP tools are exposed by the authenticated pi-bridge MCP server with pi_ prefixes. Call them directly for user tasks. If no OMP tool fits, report the missing capability and obtain explicit approval before using an Antigravity-native tool.";

export function systemRouting(mode: NativeToolMode): string {
  return TOOL_ROUTING + (mode === "disabled"
    ? "\nAntigravity-native tools are disabled for this session. Report a missing capability instead of substituting one."
    : "");
}

export function parseNativeToolMode(value: unknown): NativeToolMode {
  if (value === "prefer" || value === "disabled") return value;
  throw new Error("nativeTools must be prefer or disabled");
}

const OFFICIAL_AGENT_NAMES = new Set(["antigravity-acp", "Antigravity ACP Server"]);

export interface InitializeMetadata {
  agentInfo?: { name?: string; version?: string };
  agentCapabilities?: {
    mcpCapabilities?: {
      http?: boolean;
      [key: string]: unknown;
    };
    _meta?: {
      antigravity?: {
        systemPrompt?: { append?: boolean };
      };
    };
    [key: string]: unknown;
  };
}

export interface SessionRpcRequest {
  mcpServers?: Array<{ name?: string }>;
  _meta?: {
    antigravity?: {
      systemPrompt?: { append?: string };
      eagerMcpServers?: string[];
      enabledTools?: string[];
      disabledTools?: string[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function isOfficialAgentAtLeast(initialize: InitializeMetadata | undefined, minor: number, patch: number): boolean {
  const name = initialize?.agentInfo?.name;
  const version = initialize?.agentInfo?.version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return typeof name === "string" && OFFICIAL_AGENT_NAMES.has(name) &&
    !!version && Number(version[1]) === 1 &&
    (Number(version[2]) > minor || (Number(version[2]) === minor && Number(version[3]) >= patch));
}

export function supportsSessionRouting(initialize: InitializeMetadata | undefined): boolean {
  return isOfficialAgentAtLeast(initialize, 4, 1) &&
    initialize?.agentCapabilities?._meta?.antigravity?.systemPrompt?.append === true;
}

export function normalizeInitializeResponse<T extends InitializeMetadata>(initialize: T): T {
  if (!isOfficialAgentAtLeast(initialize, 5, 3) || initialize.agentCapabilities?.mcpCapabilities?.http !== undefined) {
    return initialize;
  }
  return {
    ...initialize,
    agentCapabilities: {
      ...initialize.agentCapabilities,
      mcpCapabilities: { ...initialize.agentCapabilities?.mcpCapabilities, http: true },
    },
  };
}

export function sessionRoutingRequest<T extends SessionRpcRequest>(request: T, initialize: InitializeMetadata | undefined, mode: NativeToolMode): T {
  if (!supportsSessionRouting(initialize)) {
    if (mode === "disabled") {
      throw new Error("Native tool filtering requires official Antigravity ACP 1.4.1+ (1.x) with system-append support; refusing to weaken disabled mode");
    }
    return request;
  }
  const previous = request._meta?.antigravity ?? {};
  const inherited = typeof previous.systemPrompt?.append === "string" ? previous.systemPrompt.append : "";
  const eager = new Set(Array.isArray(previous.eagerMcpServers) ? previous.eagerMcpServers : []);
  if (request.mcpServers?.some(server => server.name === "pi-bridge")) eager.add("pi-bridge");
  return { ...request, _meta: { ...request._meta, antigravity: {
    ...previous,
    systemPrompt: { append: [inherited, systemRouting(mode)].filter(Boolean).join("\n\n") },
    eagerMcpServers: [...eager],
    // Explicitly clear a persisted disabled filter when loading in prefer mode.
    ...(mode === "disabled" ? { enabledTools: [] } : { enabledTools: undefined, disabledTools: [] }),
  } } };
}

// The pinned upstream connection exposes session methods but not their _meta
// extension slot. Decorate its SDK RPC seam without modifying upstream files.
export function installSessionRouting(
  rpc: Record<string, (request: SessionRpcRequest) => Promise<unknown>>,
  initialized: Promise<InitializeMetadata>,
  mode: NativeToolMode,
  onApplied: (advanced: boolean) => void = () => {},
) {
  for (const name of ["newSession", "loadSession", "resumeSession"]) {
    const original = rpc[name]!.bind(rpc);
    rpc[name] = async (request: SessionRpcRequest) => {
      const initialize = await initialized;
      const routed = sessionRoutingRequest(request, initialize, mode);
      const response = await original(routed);
      onApplied(routed !== request);
      return response;
    };
  }
}
