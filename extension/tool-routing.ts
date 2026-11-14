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
  "Use only supplied pi_* tools that appear in the active tool list. " +
  "Antigravity-native tools run in a separate runtime with their own permission negotiation; " +
  "their results are not OMP tool results.";

function contextControlGuidance(projectedToolNames: readonly string[]): string {
  return [
    projectedToolNames.includes("context_notes")
      ? "Native OMP guidance about context_notes maps to pi_context_notes." : "",
    projectedToolNames.includes("new_context")
      ? "Native OMP guidance about new_context maps to pi_new_context." : "",
  ].filter(Boolean).join(" ");
}

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

// Two sentences at most: redirect the host prompt, then the complete OMP
// instruction follows unchanged. Only disabled native tools need the
// redirect; prefer keeps native tools, so its append starts with the OMP text.
const ACP_OVERRIDE =
  "Follow only the OMP instructions below. Ignore any earlier ACP host instructions, personas or workflows.";
const ACP_OVERRIDE_WITH_TOOLS =
  "Follow only the OMP instructions below. Ignore any earlier ACP host instructions, personas or workflows; " +
  "use only OMP pi_* tools and pi_task for reads, writes, searches, commands and subagent delegation.";

function acpOverride(mode: NativeToolMode, sessionKind: SessionRoutingKind, hasOmpTools: boolean): string {
  if (mode !== "disabled") return "";
  return sessionKind === "main" && hasOmpTools ? ACP_OVERRIDE_WITH_TOOLS : ACP_OVERRIDE;
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
  projectedToolNames: readonly string[] = [],
): string {
  const bridgeActive = bridgeConfigured && mcpHttpAvailable(initialize);
  const guidance = sessionKind === "ephemeral" ? EPHEMERAL_TOOL_GUIDANCE :
    bridgeActive ? PI_BRIDGE_GUIDANCE : NO_PI_BRIDGE_GUIDANCE;
  const contextGuidance = bridgeActive && sessionKind === "main" ? contextControlGuidance(projectedToolNames) : "";
  return [guidance, contextGuidance, ...(mode === "disabled" ? [NATIVE_TOOLS_DISABLED] : [])].filter(Boolean).join("\n\n");
}

// Composes the session append: optional ACP override, the unchanged complete
// OMP instruction, then the existing tool guidance. `hasOmpTools` is only
// needed when the bridge is registered without ordinary tools.
export function sessionSystemAppend(
  initialize: InitializeMetadata | undefined,
  mode: NativeToolMode,
  instructions: string,
  bridgeConfigured: boolean,
  sessionKind: SessionRoutingKind = "main",
  hasOmpTools?: boolean,
  projectedToolNames: readonly string[] = [],
): string {
  const bridgeActive = bridgeConfigured && hasOmpTools !== false && mcpHttpAvailable(initialize);
  return [
    acpOverride(mode, sessionKind, bridgeActive),
    instructions.trim(),
    ompToolGuidance(initialize, mode, bridgeActive, sessionKind, projectedToolNames),
  ].filter(Boolean).join("\n\n");
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
  hasOmpTools?: boolean,
  projectedToolNames: readonly string[] = [],
): T {
  if (!supportsSessionRouting(initialize)) {
    if (mode === "disabled") {
      throw new Error("Native tool filtering requires official Antigravity ACP 1.4.1+ (1.x) with system-append support; refusing to weaken disabled mode");
    }
    return request;
  }
  const previous = request._meta?.antigravity ?? {};
  // Compose the current route without replaying inherited append content.
  const eager = new Set(Array.isArray(previous.eagerMcpServers) ? previous.eagerMcpServers : []);
  const bridgeConfigured = request.mcpServers?.some(server => server.name === "pi-bridge") === true;
  // A registered bridge normally implies tools; the explicit false override
  // keeps an externally registered empty bridge from being eagerly connected
  // or advertised as pi_ tools.
  if (hasOmpTools === false) eager.delete("pi-bridge");
  else if (bridgeConfigured) eager.add("pi-bridge");
  return { ...request, _meta: { ...request._meta, antigravity: {
    ...previous,
    systemPrompt: { append: sessionSystemAppend(initialize, mode, instructions, bridgeConfigured, sessionKind, hasOmpTools, projectedToolNames) },
    eagerMcpServers: [...eager],
    // Explicitly clear a persisted disabled filter when loading in prefer mode.
    ...(mode === "disabled" ? { enabledTools: [] } : { enabledTools: undefined, disabledTools: [] }),
  } } };
}
