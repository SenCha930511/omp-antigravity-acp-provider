import type { InitializeResponse } from "@agentclientprotocol/sdk";

import { cloakText } from "./prompt-cloak.ts";

export type NativeToolMode = "prefer" | "disabled";

// A main session may delegate through the pi-bridge; an ephemeral side turn
// only carries the catalog so the prompt cache stays warm.
export type SessionRoutingKind = "main" | "ephemeral";

// Native OMP guidance talks about `task`; ACP exposes that declaration through
// the pi-bridge MCP server. Keep the mapping short and schema-driven instead of
// naming an agent roster the runtime cannot verify.
const PI_BRIDGE_GUIDANCE =
  "OMP tools exposed by the authenticated pi-bridge MCP server use omp_ names. " +
  "Native OMP guidance about task maps to omp_task: submit delegated work by calling omp_task, " +
  "and follow the supplied tool schema for agent selection and for delegated or parallel work. " +
  "Use the supplied wait mechanism for completion notifications. " +
  "Use only supplied omp_* tools that appear in the active tool list. " +
  "Antigravity-native tools run in a separate runtime with their own permission negotiation; " +
  "their results are not OMP tool results.";

function contextControlGuidance(projectedToolNames: readonly string[]): string {
  return [
    projectedToolNames.includes("context_notes")
      ? "Native OMP guidance about context_notes maps to omp_context_notes." : "",
    projectedToolNames.includes("new_context")
      ? "Native OMP guidance about new_context maps to omp_new_context." : "",
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

// Disabled native tools redirect the Antigravity host prompt so the OMP
// instruction owns tool use. Prefer keeps native tools, so its append starts
// with the OMP text unchanged.
const ANTIGRAVITY_OVERRIDE =
  "You are operating as the coding assistant for Oh My Pi (OMP). Follow the OMP instructions below.";
const ANTIGRAVITY_OVERRIDE_WITH_TOOLS =
  "You are operating as the coding assistant for Oh My Pi (OMP). Follow the OMP instructions below; " +
  "use only OMP omp_* tools and omp_task for reads, writes, searches, commands and subagent delegation.";

function antigravityOverride(mode: NativeToolMode, sessionKind: SessionRoutingKind, hasOmpTools: boolean): string {
  if (mode !== "disabled") return "";
  return sessionKind === "main" && hasOmpTools ? ANTIGRAVITY_OVERRIDE_WITH_TOOLS : ANTIGRAVITY_OVERRIDE;
}

export function parseNativeToolMode(value: unknown): NativeToolMode {
  if (value === "prefer" || value === "disabled") return value;
  throw new Error("nativeTools must be prefer or disabled");
}

const OFFICIAL_AGENT_NAMES = new Set(["antigravity-acp", "Antigravity ACP Server"]);

export interface InitializeMetadata {
  protocolVersion?: number;
  agentInfo?: { name?: string | null; version?: string | null; title?: string | null; _meta?: Record<string, unknown> | null } | null;
  authMethods?: ReadonlyArray<{ id?: string | null; name?: string | null; description?: string | null; _meta?: Record<string, unknown> | null }> | null;
  agentCapabilities?: {
    loadSession?: boolean;
    mcpCapabilities?: {
      http?: boolean | null;
      sse?: boolean | null;
      acp?: boolean | null;
      _meta?: Record<string, unknown> | null;
      [key: string]: unknown;
    } | null;
    promptCapabilities?: {
      image?: boolean | null;
      audio?: boolean | null;
      embeddedContext?: boolean | null;
      _meta?: Record<string, unknown> | null;
      [key: string]: unknown;
    } | null;
    _meta?: Record<string, unknown> | null;
    [key: string]: unknown;
  } | null;
  _meta?: Record<string, unknown> | null;
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
  if (!isOfficialAgentAtLeast(initialize, 4, 1)) return false;
  const meta = initialize?.agentCapabilities?._meta;
  const antigravity = meta && typeof meta === "object" ? Reflect.get(meta, "antigravity") : undefined;
  const systemPrompt = antigravity && typeof antigravity === "object" ? Reflect.get(antigravity, "systemPrompt") : undefined;
  return Boolean(systemPrompt && typeof systemPrompt === "object" && Reflect.get(systemPrompt, "append") === true);
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

// agy refuses a prompt that embeds OMP's internal tool and device schemas:
// they are not valid for its runtime and only spend the customization budget.
// Section removal is line-based with fence tracking, so a `#` or `<` inside a
// fenced sample never truncates the section, and subheadings stay part of the
// section they belong to.
const INTERNAL_SECTIONS: ReadonlyArray<{ readonly level: number; readonly heading: RegExp }> = [
  { level: 1, heading: /^#\s+Internal URLs\s*$/ },
  { level: 1, heading: /^#\s+xd:\/\/\s*Tool Devices\s*$/ },
  { level: 2, heading: /^##\s+MCP Tool Routes\s*$/ },
];

function headingLevel(line: string): number | undefined {
  const match = /^(#{1,6})\s/.exec(line);
  return match ? match[1]!.length : undefined;
}

interface Fence {
  readonly char: "`" | "~";
  readonly length: number;
}

function openingFence(line: string): Fence | undefined {
  const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return undefined;
  return { char: match[1]![0] as "`" | "~", length: match[1]!.length };
}

function closesFence(line: string, open: Fence): boolean {
  const match = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return match !== null && match[1]![0] === open.char && match[1]!.length >= open.length;
}

// Marks every line belonging to a fenced code block, delimiters included.
// Opening and closing runs are tracked separately: a triple-backtick example
// inside a four-backtick fence is content, not a close.
function fencedLines(lines: readonly string[]): boolean[] {
  const fenced: boolean[] = [];
  let open: Fence | undefined;
  for (const line of lines) {
    if (open !== undefined) {
      fenced.push(true);
      if (closesFence(line, open)) open = undefined;
      continue;
    }
    const opening = openingFence(line);
    if (opening !== undefined) {
      open = opening;
      fenced.push(true);
      continue;
    }
    fenced.push(false);
  }
  return fenced;
}

function isSectionBoundary(line: string, level: number): boolean {
  if (line.startsWith("⁂") || line.startsWith("<")) return true;
  const heading = headingLevel(line);
  return heading !== undefined && heading <= level;
}

function internalSectionRanges(lines: readonly string[], fenced: readonly boolean[]): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  for (let index = 0; index < lines.length; index++) {
    if (fenced[index]) continue;
    const section = INTERNAL_SECTIONS.find(candidate => candidate.heading.test(lines[index]!));
    if (!section) continue;
    let end = index + 1;
    while (end < lines.length && (fenced[end] || !isSectionBoundary(lines[end]!, section.level))) end++;
    ranges.push([index, end]);
    index = end - 1;
  }
  return ranges;
}

// Balanced-brace scan for `namespace functions { ... }`, skipping strings and
// comments so a brace in a type literal or comment cannot end the block early.
// Returns the closing line, or undefined when the block never closes.
function namespaceClosingLine(lines: readonly string[], start: number): number | undefined {
  const openColumn = lines[start]!.indexOf("{");
  if (openColumn < 0) return undefined;
  let depth = 0;
  let blockComment = false;
  let quote: "'" | '"' | "`" | undefined;
  for (let line = start; line < lines.length; line++) {
    const text = lines[line]!;
    for (let column = line === start ? openColumn : 0; column < text.length; column++) {
      const char = text[column];
      if (blockComment) {
        if (char === "*" && text[column + 1] === "/") {
          blockComment = false;
          column++;
        }
        continue;
      }
      if (quote !== undefined) {
        if (char === "\\") column++;
        else if (char === quote) quote = undefined;
        continue;
      }
      if (char === "/" && text[column + 1] === "/") break;
      if (char === "/" && text[column + 1] === "*") {
        blockComment = true;
        column++;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0) return line;
      }
    }
  }
  return undefined;
}

// The heading directly above the block and a trailing `// namespace functions`
// comment belong to the same generated schema fragment.
function namespaceRange(
  lines: readonly string[],
  fenced: readonly boolean[],
  start: number,
  closing: number,
): readonly [number, number] {
  let from = start;
  for (let line = start - 1; line >= 0; line--) {
    if (lines[line]!.trim() === "") continue;
    if (!fenced[line] && /^#{1,6}\s+functions\s*$/.test(lines[line]!)) from = line;
    break;
  }
  let to = closing + 1;
  for (let line = closing + 1; line < lines.length; line++) {
    const text = lines[line]!.trim();
    if (text === "") continue;
    if (/^\/\/\s*namespace functions\b/.test(text)) {
      to = line + 1;
      continue;
    }
    break;
  }
  return [from, to];
}

export function cleanOmpSystemInstructions(instructions: string): string {
  if (!instructions) return "";
  const lines = instructions.split("\n");
  const fenced = fencedLines(lines);
  const dropped = lines.map(() => false);
  for (const [from, to] of internalSectionRanges(lines, fenced)) {
    for (let line = from; line < to; line++) dropped[line] = true;
  }
  for (let line = 0; line < lines.length; line++) {
    if (fenced[line]) continue;
    if (!/^\s*namespace\s+functions\s*\{/.test(lines[line]!)) continue;
    const closing = namespaceClosingLine(lines, line);
    // An unbalanced block is left alone: truncating the rest of the prompt
    // would delete user instructions instead of internal schema text.
    if (closing === undefined) continue;
    const [from, to] = namespaceRange(lines, fenced, line, closing);
    for (let index = from; index < to; index++) dropped[index] = true;
    line = to - 1;
  }
  if (!dropped.some(Boolean)) return instructions;
  return lines.filter((_, index) => !dropped[index]).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Composes the session append: optional Antigravity override, the cleaned
// complete OMP instruction, then the existing tool guidance. Disabled mode
// also rewords known fingerprint phrases agy refuses with 429s; prefer stays
// byte-identical apart from the cleaning above.
// `hasOmpTools` is only needed when the bridge is registered without tools.
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
  const cleaned = cleanOmpSystemInstructions(instructions);
  const instructionText = mode === "disabled" ? cloakText(cleaned).text : cleaned;
  return [
    antigravityOverride(mode, sessionKind, bridgeActive),
    instructionText,
    ompToolGuidance(initialize, mode, bridgeActive, sessionKind, projectedToolNames),
  ].filter(Boolean).join("\n\n");
}

export function normalizeInitializeResponse(initialize: InitializeResponse): InitializeResponse;
export function normalizeInitializeResponse(initialize: InitializeMetadata): InitializeMetadata;
export function normalizeInitializeResponse(initialize: InitializeMetadata): InitializeMetadata {
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
  // or advertised as omp_ tools.
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
