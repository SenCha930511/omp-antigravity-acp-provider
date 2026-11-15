import { inspectToolArguments, normalizeToolArguments, renderToolSignature } from "./args.ts";
import type { McpServer as AcpMcpServer } from "@agentclientprotocol/sdk";
import type { Tool } from "@earendil-works/pi-ai";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Value } from "typebox/value";

import { AntigravityAcpError } from "../acp/errors.ts";
import { PACKAGE_VERSION, PERMISSION_TOOL_NAME } from "../constants.ts";
import { projectedMcpName } from "./relay.ts";
import { projectToolSchema } from "./schema.ts";

const BODY_LIMIT = 1024 * 1024;
const MAX_TOOLS = 64;
export const OMP_TASK_TOOL_NAME = "task";

export interface ToolProjectionInput {
	name: string;
	description?: string;
	parameters?: unknown;
}

const CONTEXT_CONTROL_TOOLS = new Set(["context_notes", "new_context"]);

export function bridgeExecutionSchema(tool: Pick<Tool, "name" | "parameters">): Tool["parameters"];
export function bridgeExecutionSchema(tool: ToolProjectionInput): unknown;
export function bridgeExecutionSchema(tool: ToolProjectionInput): unknown {
	const parameters = tool.parameters;
	if (!CONTEXT_CONTROL_TOOLS.has(tool.name) || parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
		return parameters;
	}
	const schema = parameters as unknown as Record<string, unknown>;
	const properties = schema.properties;
	const required = schema.required;
	if (schema.type !== "object" || schema.additionalProperties !== false ||
		properties === null || typeof properties !== "object" || Array.isArray(properties) ||
		!Array.isArray(required) || !required.includes("i")) {
		return parameters;
	}
	const expectedKeys = tool.name === "context_notes" ? ["i", "text"] : ["i"];
	if (Object.keys(properties).length !== expectedKeys.length ||
		!expectedKeys.every(key => Object.hasOwn(properties, key))) {
		return parameters;
	}
	const intent = Reflect.get(properties, "i");
	const text = Reflect.get(properties, "text");
	if (intent === null || typeof intent !== "object" || Array.isArray(intent) || Reflect.get(intent, "type") !== "string" ||
		(tool.name === "context_notes" && (text === null || typeof text !== "object" || Array.isArray(text) || Reflect.get(text, "type") !== "string"))) {
		return parameters;
	}
	// These two native tools receive OMP's injected intent as call metadata,
	// not as an execute argument. Keep the property and supplied value intact.
	return { ...schema, required: required.filter(key => key !== "i") };
}

interface BridgeTool {
	mcpName: string;
	piName: string;
	description: string;
	inputSchema: Record<string, unknown>;
	originalSchema: Tool["parameters"];
	// Preserved source `_meta`, merged into every tools/list entry.
	meta: Record<string, unknown>;
}

/** A tools/list entry as serialized toward agy. */
export interface BridgeToolListing {
	name: string;
	description?: string;
	inputSchema?: unknown;
	_meta?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface PiToolInvocation {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface PiMcpBridgeOptions {
	tools: readonly Tool[];
	onCall: (invocation: PiToolInvocation) => Promise<CallToolResult>;
}

export interface ToolOmission {
	name: string;
	reason: string;
}

export function piToolFingerprint(tools: readonly Tool[]): string {
	const omissions: ToolOmission[] = [];
	const projected = projectTools(tools, omissions);
	return projectionFingerprint(projected, omissions);
}

function projectionFingerprint(tools: BridgeTool[], omissions: ToolOmission[]): string {
	return JSON.stringify([tools.map((tool) => [tool.mcpName, tool.description, tool.inputSchema]), omissions]);
}

export function planToolProjection(tools: readonly ToolProjectionInput[]): ToolOmission[] {
	const omissions: ToolOmission[] = [];
	projectTools(tools, omissions);
	return omissions;
}

export function planProjectedToolNames(tools: readonly ToolProjectionInput[]): readonly string[] {
	return projectTools(tools, []).map(tool => tool.piName);
}

// agy holds every MCP tool it loads in one customization budget of roughly
// 20,000 tokens, counted as ceil(UTF-8 bytes / 3) over each serialized tool
// entry, and drops whole tools (largest first) past it. Fitting trims only
// description prose, so every tool, name, schema key, type, enum, required,
// items and bound stays listed exactly as projected.
export const TOOL_TOKEN_BUDGET = 18000;

function tokensOf(tools: readonly BridgeToolListing[]): number {
	return tools.reduce((total, tool) => total + Math.ceil(Buffer.byteLength(JSON.stringify(tool), "utf8") / 3), 0);
}

// Descriptions cut shorter than this say nothing ("The fil…") and only spend
// the budget on their key, so a cap below it drops the text entirely.
const MIN_TEXT = 24;

// Shortens text to at most `max` UTF-8 bytes: a trailing Examples block goes
// first, then a sentence boundary near the cut, marked with "…".
function cutDescription(text: string, max: number): string | undefined {
	if (Buffer.byteLength(text, "utf8") <= max) return text;
	const bare = text.replace(/\s*\bExamples?:[\s\S]*$/i, "").trimEnd();
	if (bare && Buffer.byteLength(bare, "utf8") <= max) return bare;
	const room = max - Buffer.byteLength("…", "utf8");
	if (room < 4) return undefined;
	let out = "";
	let used = 0;
	for (const ch of bare || text) {
		const size = Buffer.byteLength(ch, "utf8");
		if (used + size > room) break;
		out += ch;
		used += size;
	}
	const stop = Math.max(...[". ", "; ", "。", "；"].map((sep) => out.lastIndexOf(sep)));
	if (stop > out.length / 2) out = out.slice(0, stop + 1);
	return out.trimEnd() + "…";
}

function trimDescription(text: string, cap: number): string | undefined {
	if (Buffer.byteLength(text, "utf8") <= cap) return text;
	return cap < MIN_TEXT ? undefined : cutDescription(text, cap);
}

// Recursively caps every `description` string; every other key and value
// passes through untouched, so no schema constraint ever moves.
function shapeDescriptions(node: unknown, cap: number): unknown {
	if (Array.isArray(node)) return node.map((item) => shapeDescriptions(item, cap));
	if (node === null || typeof node !== "object") return node;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "description" && typeof value === "string") {
			const text = trimDescription(value, cap);
			if (text !== undefined) out.description = text;
			continue;
		}
		out[key] = shapeDescriptions(value, cap);
	}
	return out;
}

function shapeTool(tool: BridgeToolListing, cap: number): BridgeToolListing {
	const out: BridgeToolListing = { ...tool };
	if (typeof tool.description === "string") {
		const text = trimDescription(tool.description, cap);
		if (text === undefined) delete out.description;
		else out.description = text;
	}
	if (tool.inputSchema !== undefined) out.inputSchema = shapeDescriptions(tool.inputSchema, cap);
	return out;
}

function longestDescription(tools: readonly BridgeToolListing[]): number {
	let max = 0;
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		if (node === null || typeof node !== "object") return;
		for (const [key, value] of Object.entries(node)) {
			if (key === "description" && typeof value === "string") {
				max = Math.max(max, Buffer.byteLength(value, "utf8"));
			} else {
				visit(value);
			}
		}
	};
	for (const tool of tools) {
		if (typeof tool.description === "string") max = Math.max(max, Buffer.byteLength(tool.description, "utf8"));
		visit(tool.inputSchema);
	}
	return max;
}

/** Pure: when the listed tools exceed agy's token budget, progressively
 * shorten only description text (binary-searching one byte cap applied to
 * every description) and never drop a tool. Fitting lists return unchanged. */
export function fitToolsToBudget(tools: BridgeToolListing[], budget = TOOL_TOKEN_BUDGET): BridgeToolListing[] {
	if (!Array.isArray(tools) || tools.length === 0) return tools;
	if (tokensOf(tools) <= budget) return tools;
	const at = (cap: number): BridgeToolListing[] => tools.map((tool) => shapeTool(tool, cap));
	// Even with every description gone the list is over budget: keep every
	// tool and let agy see as much schema as fits.
	if (tokensOf(at(0)) > budget) return at(0);
	// Largest cap whose shape still fits. At the longest description the
	// shape is the original over-budget list, so the search always narrows.
	let lo = 0;
	let hi = longestDescription(tools);
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (tokensOf(at(mid)) <= budget) lo = mid;
		else hi = mid - 1;
	}
	return at(lo);
}

export class PiMcpBridge {
	fingerprint: string;
	readonly omissions: ToolOmission[] = [];
	private readonly token = crypto.randomUUID().replaceAll("-", "");
	private tools: BridgeTool[];
	private server: ReturnType<typeof createServer> | undefined;
	private url: string | undefined;
	private readonly responses = new Set<ServerResponse>();

	constructor(private readonly options: PiMcpBridgeOptions) {
		this.tools = projectTools(options.tools, this.omissions);
		this.fingerprint = projectionFingerprint(this.tools, this.omissions);
	}

	updateTools(tools: readonly Tool[]): void {
		this.omissions.length = 0;
		this.tools = projectTools(tools, this.omissions);
		this.fingerprint = projectionFingerprint(this.tools, this.omissions);
	}

	get empty(): boolean {
		return this.tools.length === 0;
	}

	get projectedToolNames(): readonly string[] {
		return this.tools.map(tool => tool.piName);
	}

	async start(): Promise<AcpMcpServer | undefined> {
		if (this.empty) return undefined;
		if (this.server && this.url) return this.descriptor();
		this.server = createServer((request, response) => {
			void this.handle(request, response).catch(() => {
				if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
				response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "MCP bridge error" } }));
			});
		});
		this.server.maxConnections = 8;
		this.server.keepAliveTimeout = 0;
		this.server.requestTimeout = 0;
		this.server.headersTimeout = 0;
		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(0, "127.0.0.1", resolve);
		});
		const address = this.server.address();
		if (!address || typeof address === "string") throw new AntigravityAcpError("spawn", "MCP bridge failed to bind");
		this.url = `http://127.0.0.1:${address.port}/mcp`;
		return this.descriptor();
	}

	async close(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.url = undefined;
		if (!server) return;
		const closing = new Promise<void>((resolve) => server.close(() => resolve()));
		for (const response of this.responses) response.destroy();
		this.responses.clear();
		server.closeAllConnections();
		await closing;
	}

	private descriptor(): AcpMcpServer {
		if (!this.url) throw new AntigravityAcpError("spawn", "MCP bridge is not listening");
		return {
			type: "http",
			name: "pi-bridge",
			url: this.url,
			headers: [{ name: "Authorization", value: `Bearer ${this.token}` }],
		};
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		this.responses.add(response);
		response.once("close", () => this.responses.delete(response));
		if (request.url !== "/mcp" || request.method !== "POST") {
			response.writeHead(405).end();
			return;
		}
		if (!validBearerToken(request.headers.authorization, this.token)) {
			response.writeHead(401).end();
			return;
		}
		let body: unknown;
		try {
			body = await readJson(request);
		} catch (error) {
			if (error instanceof SyntaxError) {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
				return;
			}
			throw error;
		}
		const protocol = new Server(
			{ name: "pi-antigravity-acp-tools", version: PACKAGE_VERSION },
			{ capabilities: { tools: {} } },
		);
		protocol.setRequestHandler(ListToolsRequestSchema, () => ({
			// agy loads these entries into one shared customization budget; the
			// alwaysLoad meta keeps each tool loaded and the fitting trims only
			// description prose when the budget would otherwise drop tools.
			tools: fitToolsToBudget(this.tools.map((tool) => ({
				name: tool.mcpName,
				description: tool.description,
				inputSchema: tool.inputSchema as { type: "object"; properties?: Record<string, object> },
				_meta: { ...tool.meta, "antigravity/alwaysLoad": true },
			}))),
		}));
		protocol.setRequestHandler(CallToolRequestSchema, async (call) => {
			const tool = this.tools.find((candidate) => candidate.mcpName === call.params.name);
			if (!tool) return toolError("Unknown or inactive Pi tool");
			const args = call.params.arguments ?? {};
			const normalized = normalizeToolArguments(tool.originalSchema, args);
			const missing = inspectToolArguments(tool.originalSchema, normalized.arguments).missing;
			let ompValidated = true;
			try {
				if (!Value.Check(tool.originalSchema, normalized.arguments)) ompValidated = false;
			} catch {
				return toolError(tool.mcpName + ": the original Pi tool schema could not validate these arguments. Expected signature: " + renderToolSignature(tool.mcpName, tool.originalSchema) + ". Correct the parameters and retry without repeating the same call.");
			}
			if (!ompValidated || missing.length > 0) {
				const ompMissing = missing.length > 0 ? "missing required " + missing.join(", ") + ". " : "";
				return toolError(tool.mcpName + ": " + ompMissing + "Expected signature: " + renderToolSignature(tool.mcpName, tool.originalSchema) + ". Correct the parameters and retry without repeating the same call.");
			}
			return this.options.onCall({ id: crypto.randomUUID(), name: tool.piName, arguments: normalized.arguments });
		});
		const transport = new StreamableHTTPServerTransport(
			{ sessionIdGenerator: undefined } as unknown as ConstructorParameters<
				typeof StreamableHTTPServerTransport
			>[0],
		);
		try {
			await protocol.connect(transport as Parameters<typeof protocol.connect>[0]);
			await transport.handleRequest(request, response, body);
		} finally {
			await transport.close();
			await protocol.close();
		}
	}
}

// A tool may carry a `_meta` object (e.g. forwarded from an upstream server);
// keep a copy so tools/list entries can merge it with agy's alwaysLoad marker.
function preserveMeta(tool: ToolProjectionInput): Record<string, unknown> {
	const meta = (tool as { _meta?: unknown })._meta;
	if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return {};
	return { ...(meta as Record<string, unknown>) };
}

function projectTool(tool: Tool, names: Set<string>): BridgeTool | ToolOmission;
function projectTool(tool: ToolProjectionInput, names: Set<string>): (Omit<BridgeTool, "originalSchema"> & { originalSchema: unknown }) | ToolOmission;
function projectTool(tool: ToolProjectionInput, names: Set<string>): (Omit<BridgeTool, "originalSchema"> & { originalSchema: unknown }) | ToolOmission {
	const mcpName = projectedMcpName(tool.name);
	if (!mcpName || names.has(mcpName)) {
		return { name: tool.name, reason: "duplicate or invalid projected name" };
	}
	const originalSchema = bridgeExecutionSchema(tool);
	const projected = projectToolSchema(originalSchema);
	if ("reason" in projected) {
		return { name: tool.name, reason: `schema omitted (${projected.reason})` };
	}
	names.add(mcpName);
	return {
		mcpName,
		piName: tool.name,
		description: tool.description ?? "",
		inputSchema: projected.schema,
		originalSchema,
		meta: preserveMeta(tool),
	};
}

// Keep the first 64 projectable tools in OMP's input order. When `task` would
// fall beyond that boundary, hold one slot open so the delegated-work
// declaration survives without moving any retained tool.
function projectTools(tools: readonly Tool[], omissions: ToolOmission[]): BridgeTool[];
function projectTools(tools: readonly ToolProjectionInput[], omissions: ToolOmission[]): Array<Omit<BridgeTool, "originalSchema"> & { originalSchema: unknown }>;
function projectTools(tools: readonly ToolProjectionInput[], omissions: ToolOmission[]): Array<Omit<BridgeTool, "originalSchema"> & { originalSchema: unknown }> {
	const selected = new Map<number, Omit<BridgeTool, "originalSchema"> & { originalSchema: unknown }>();
	const rejected = new Map<number, string>();
	const limitSkipped = new Set<number>();
	const names = new Set<string>();
	const taskPresent = tools.some((tool) => tool.name === OMP_TASK_TOOL_NAME);
	let taskAccepted = false;
	const attempt = (index: number): void => {
		const result = projectTool(tools[index]!, names);
		if ("reason" in result) {
			rejected.set(index, result.reason);
			return;
		}
		selected.set(index, result);
		if (tools[index]!.name === OMP_TASK_TOOL_NAME) taskAccepted = true;
	};
	for (let index = 0; index < tools.length; index++) {
		const tool = tools[index]!;
		if (tool.name === PERMISSION_TOOL_NAME) continue;
		const isTask = tool.name === OMP_TASK_TOOL_NAME;
		if (!isTask && taskPresent && !taskAccepted && selected.size >= MAX_TOOLS - 1) {
			limitSkipped.add(index);
			continue;
		}
		if (selected.size >= MAX_TOOLS) {
			limitSkipped.add(index);
			continue;
		}
		attempt(index);
	}
	// A reserved slot is only useful if `task` itself is projectable. If it is
	// invalid, restore the ordinary first-64 behavior from the earliest skipped
	// candidates without reordering what was already retained.
	if (taskPresent && !taskAccepted) {
		for (const index of [...limitSkipped].sort((a, b) => a - b)) {
			if (selected.size >= MAX_TOOLS) break;
			attempt(index);
			limitSkipped.delete(index);
		}
	}
	for (let index = 0; index < tools.length; index++) {
		const tool = tools[index]!;
		if (tool.name === PERMISSION_TOOL_NAME || selected.has(index)) continue;
		const reason = rejected.get(index);
		if (reason) omissions.push({ name: tool.name, reason });
		else if (limitSkipped.has(index)) omissions.push({ name: tool.name, reason: `Tool limit ${MAX_TOOLS} reached` });
	}
	return [...selected.entries()].sort(([a], [b]) => a - b).map(([, tool]) => tool);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
		size += bytes.length;
		if (size > BODY_LIMIT) throw new AntigravityAcpError("invalid_input", "MCP request body is too large");
		chunks.push(bytes);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validBearerToken(header: string | undefined, token: string): boolean {
	const actual = Buffer.from(header ?? "");
	const expected = Buffer.from(`Bearer ${token}`);
	return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function toolError(text: string): CallToolResult {
	return { content: [{ type: "text", text }], isError: true };
}
