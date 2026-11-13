export type NativeToolMode = "prefer" | "disabled";

// A main session may delegate through the pi-bridge; an ephemeral side turn
// only carries the catalog so the prompt cache stays warm.
export type SessionRoutingKind = "main" | "ephemeral";

// Native OMP guidance talks about `task`; ACP exposes that declaration through
// the pi-bridge MCP server. Keep the mapping short and schema-driven instead of
// naming an agent roster the runtime cannot verify.
const PI_BRIDGE_GUIDANCE =
  "OMP tools exposed by the authenticated pi-bridge MCP server use pi_ names. " +
  "Native OMP guidance about task maps to pi_task: submit delegated work by calling pi_task, " +
  "and follow the supplied tool schema for agent selection and for delegated or parallel work. " +
  "Use the supplied wait mechanism for completion notifications. " +
  "Antigravity-native tools run in a separate runtime with their own permission negotiation; " +
  "their results are not OMP tool results.";

const NO_PI_BRIDGE_GUIDANCE =
  "The pi-bridge MCP server is not available on this runtime, so no OMP tools are exposed. " +
  "Do not claim an OMP tool is available; report the missing capability.";

const NATIVE_TOOLS_DISABLED =
  "Antigravity-native tools are disabled for this session. Report a missing capability instead of substituting one.";

// Mirrors OMP's real ephemeral side-turn instruction: the catalog is supplied
// only to keep the prompt cache warm, and no tool call in that turn executes.
const EPHEMERAL_TOOL_GUIDANCE =
  "This is an ephemeral side turn. The tool catalog is attached only to keep the prompt cache warm; " +
  "no tools may be called in this side turn, and tool calls are discarded without execution. " +
  "Reply with plain text only.";

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

// The runtime only starts the pi-bridge when the agent advertises HTTP MCP.
// Normalize the official 1.5.3+ omission before deciding what the session may
// advertise; otherwise the append channel would claim tools the bridge never
// exposes.
export function mcpHttpAvailable(initialize: InitializeMetadata | undefined): boolean {
  return initialize !== undefined &&
    normalizeInitializeResponse(initialize).agentCapabilities?.mcpCapabilities?.http === true;
}

// Shared by the system-append channel and the legacy instructions resource so
// both paths describe the same bridge availability and delegation mapping.
export function ompToolGuidance(
  initialize: InitializeMetadata | undefined,
  mode: NativeToolMode,
  bridgeConfigured: boolean,
  sessionKind: SessionRoutingKind = "main",
): string {
  if (sessionKind === "ephemeral") return EPHEMERAL_TOOL_GUIDANCE;
  const guidance = bridgeConfigured && mcpHttpAvailable(initialize) ? PI_BRIDGE_GUIDANCE : NO_PI_BRIDGE_GUIDANCE;
  return [guidance, ...(mode === "disabled" ? [NATIVE_TOOLS_DISABLED] : [])].join("\n\n");
}

export function sessionSystemAppend(
  initialize: InitializeMetadata | undefined,
  mode: NativeToolMode,
  instructions: string,
  bridgeConfigured: boolean,
  sessionKind: SessionRoutingKind = "main",
): string {
  return [instructions.trim(), ompToolGuidance(initialize, mode, bridgeConfigured, sessionKind)].filter(Boolean).join("\n\n");
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

export function sessionRoutingRequest<T extends SessionRpcRequest>(
  request: T,
  initialize: InitializeMetadata | undefined,
  mode: NativeToolMode,
  instructions: string,
  sessionKind: SessionRoutingKind = "main",
): T {
  if (!supportsSessionRouting(initialize)) {
    if (mode === "disabled") {
      throw new Error("Native tool filtering requires official Antigravity ACP 1.4.1+ (1.x) with system-append support; refusing to weaken disabled mode");
    }
    return request;
  }
  const previous = request._meta?.antigravity ?? {};
  const inherited = typeof previous.systemPrompt?.append === "string" ? previous.systemPrompt.append : "";
  const eager = new Set(Array.isArray(previous.eagerMcpServers) ? previous.eagerMcpServers : []);
  const bridgeConfigured = request.mcpServers?.some(server => server.name === "pi-bridge") === true;
  if (bridgeConfigured) eager.add("pi-bridge");
  return { ...request, _meta: { ...request._meta, antigravity: {
    ...previous,
    systemPrompt: { append: [inherited, sessionSystemAppend(initialize, mode, instructions, bridgeConfigured, sessionKind)].filter(Boolean).join("\n\n") },
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
  instructions: () => string,
  sessionKind: SessionRoutingKind | (() => SessionRoutingKind) = "main",
  onApplied: (advanced: boolean) => void = () => {},
) {
  for (const name of ["newSession", "loadSession", "resumeSession"]) {
    const original = rpc[name]!.bind(rpc);
    rpc[name] = async (request: SessionRpcRequest) => {
      const initialize = await initialized;
      const kind = typeof sessionKind === "function" ? sessionKind() : sessionKind;
      const routed = sessionRoutingRequest(request, initialize, mode, instructions(), kind);
      const response = await original(routed);
      onApplied(routed !== request);
      return response;
    };
  }
}
