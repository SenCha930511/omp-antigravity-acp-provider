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
import { projectToolSchema } from "./schema.ts";

const BODY_LIMIT = 1024 * 1024;
const MAX_TOOLS = 64;
export const OMP_TASK_TOOL_NAME = "task";

interface BridgeTool {
	mcpName: string;
	piName: string;
	description: string;
	inputSchema: Record<string, unknown>;
	originalSchema: Tool["parameters"];
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

export function planToolProjection(tools: readonly Tool[]): ToolOmission[] {
	const omissions: ToolOmission[] = [];
	projectTools(tools, omissions);
	return omissions;
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
		const body = await readJson(request);
		const protocol = new Server(
			{ name: "pi-antigravity-acp-tools", version: PACKAGE_VERSION },
			{ capabilities: { tools: {} } },
		);
		protocol.setRequestHandler(ListToolsRequestSchema, () => ({
			tools: this.tools.map((tool) => ({
				name: tool.mcpName,
				description: tool.description,
				inputSchema: tool.inputSchema as { type: "object"; properties?: Record<string, object> },
			})),
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

function projectTool(tool: Tool, names: Set<string>): BridgeTool | ToolOmission {
	const mcpName = `pi_${tool.name}`.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 64);
	if (!mcpName || names.has(mcpName)) {
		return { name: tool.name, reason: "duplicate or invalid projected name" };
	}
	const projected = projectToolSchema(tool.parameters);
	if ("reason" in projected) {
		return { name: tool.name, reason: `schema omitted (${projected.reason})` };
	}
	names.add(mcpName);
	return {
		mcpName,
		piName: tool.name,
		description: tool.description,
		inputSchema: projected.schema,
		originalSchema: tool.parameters,
	};
}

// Keep the first 64 projectable tools in OMP's input order. When `task` would
// fall beyond that boundary, hold one slot open so the delegated-work
// declaration survives without moving any retained tool.
function projectTools(tools: readonly Tool[], omissions: ToolOmission[]): BridgeTool[] {
	const selected = new Map<number, BridgeTool>();
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
