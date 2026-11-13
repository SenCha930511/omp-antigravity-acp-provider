import { AcpFailure } from "../acp-errors.ts";
import { ToolRelay, resolveRelayConfig, relayControlTool, projectedMcpName, TOOL_RELAY_CONTROL_NAME } from "./tools/relay.ts";
import { claimContinuation } from "../continuation-claim.ts";
import { drainCancelledTurn, isSteerAbort, steerMode } from "../turn-cancellation.ts";
import { createHistoryFingerprintMemo, createStructuredFingerprintMemo } from "./binding.ts";
import { ompToolGuidance, type NativeToolMode, type SessionRoutingKind } from "../tool-routing.ts";
import type {
	ContentBlock,
	InitializeResponse,
	PromptResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import {
	collapseSystemMessages,
	getCurrentSystemPrompt,
	getCurrentTools,
	normalizeContext,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type ToolResultMessage,
	type JsonValue,
	type TextContent,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";

import {
	clearAntigravityCredentials,
	inspectAntigravityAuth,
	type AntigravityAuthHealth,
} from "./acp/antigravity.ts";
import { AntigravityAcpConnection, type AntigravityConnectionOptions } from "./acp/connection.ts";
import { abortError, AntigravityAcpError, errorMessage } from "./acp/errors.ts";
import { parseUsageQuota, quotaExhaustion, type AntigravityQuotaSnapshot } from "../usage-accounting.ts";
import { AcpSessionStore } from "../session-store.ts";
import { sessionModels, sessionModes, type AcpModelInfo, type AcpNewSessionResponse, type SessionState } from "./acp/session-state.ts";
import {
	MANAGED_AUTH_MARKER,
	PERMISSION_RESULT_KIND,
	PERMISSION_TOOL_NAME,
	usableApiKey,
} from "./constants.ts";
export { MANAGED_AUTH_MARKER, PERMISSION_RESULT_KIND, PERMISSION_TOOL_NAME, usableApiKey } from "./constants.ts";
import { mapSessionUpdate } from "./acp/events.ts";
import { ensureAntigravityAcpReady } from "./managed.ts";
import { HeadlessOAuthRelay, shouldUseHeadlessOAuth } from "./acp/headless-oauth.ts";
import {
	PiMcpBridge,
	piToolFingerprint,
	planToolProjection,
	type ToolOmission,
	type PiToolInvocation,
} from "./tools/bridge.ts";
import type { PermissionMode } from "./config.ts";
import { resolveAcpModelId } from "./models.ts";
import { type PromptParts, buildPromptParts, currentSystemInstructions, stableSystemInstructions, estimateContextTokens } from "./prompt.ts";
import { resolveSessionRoute, type SessionRoute } from "./routing.ts";
import { PiEventWriter } from "./stream/pi-events.ts";
import { usageFromPrompt, type PromptUsageResult } from "../usage.ts";
import { RuntimeMetrics } from "./status.ts";

const ompMessageFingerprintMemo = createHistoryFingerprintMemo();

interface OmpQuotaRequest {
	epoch: number;
	owner: string;
	controller: AbortController;
	subscribers: number;
	snapshot: Promise<AntigravityQuotaSnapshot>;
}

const PERMISSION_TIMEOUT_MS = 120_000;
const TOOL_BATCH_MS = 100;

type AntigravityModel = Model<"antigravity-acp">;

// OMP passes its routing identity beside the Pi stream options. The complete Pi
// option object stays intact; only these adapter-only fields are read here.
export interface OmpStreamOptions extends SimpleStreamOptions {
	/** Owning main routing id for an OMP side (`/btw`) request. */
	parentSessionId?: string;
	/** OMP prompt cache key; carried through unchanged. */
	promptCacheKey?: string;
}

interface PendingPermission {
	id: string;
	request: RequestPermissionRequest;
	resolve: (response: RequestPermissionResponse) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface PendingPiTool {
	invocation: PiToolInvocation;
	/** Resolve the MCP request and release its bounded work-watchdog hold. */
	resolve: (result: CallToolResult) => void;
}

// A main binding checkpoints OMP transcript history in the session store. A
// shadow binding checkpoints only what its own ACP session absorbed: it never
// reads or writes the main checkpoint, the store, or the OMP source mapping.
export type ShadowRebuildReason = "cancelled" | "failed" | "rewind" | "model-or-mode-change" | "instructions";

export type ShadowCheckpoint =
	| {
		kind: "clean";
		/** Normalized fingerprints of every side-context message at dispatch. */
		fingerprints: readonly string[];
		/** Leading main-history messages; the trailing ephemeral scaffold is excluded. */
		absorbed: number;
		modelId: string;
		mode: PermissionMode;
		instructions: string;
	}
	| { kind: "uncertain"; reason: ShadowRebuildReason };

interface Binding {
 ompFallbackContextTokens?: number; ompInFlight: boolean; ompInvalidated: boolean; ompCompactionInvalidated?: boolean; ompSeeding?: boolean; ompSeedText?: string; ompDropPromise?: Promise<void>; ompExpectedAssistantHasOutput: boolean; ompExpectedAssistantNormalized?: string; ompConversationFingerprint?: string; ompReleaseLease?: (wait?: boolean) => Promise<void>; pendingConversationFingerprint?: string; relay: ToolRelay; relayBridge?: PiMcpBridge; relayFingerprint: string;
	ompTerminalStopReason?: PromptResponse["stopReason"];
	ompCancelledCheckpoint?: boolean;
	ompCancelledHadOutput?: boolean;
	key: string;
	route: SessionRoute;
	/** Present only for a shadow binding. */
	shadow?: ShadowCheckpoint;
	cwd: string;
	connection: AntigravityAcpConnection;
	initialize: InitializeResponse;
	session: AcpNewSessionResponse;
	mode: PermissionMode;
	instructionsFingerprint: string | undefined;
	needsReconstruction: boolean;
	modelId: string;
	messageCount: number;
	historyFingerprint: string;
	expectedAssistantFingerprint: string | undefined;
	pendingContextCount: number;
	pendingContextFingerprint: string;
	writer: PiEventWriter | undefined;
	permission: PendingPermission | undefined;
	pendingTools: Map<string, PendingPiTool>;
	toolBatchTimer: ReturnType<typeof setTimeout> | undefined;
	bridge: PiMcpBridge | undefined;
	toolFingerprint: string;
	omittedTools: ToolOmission[];
	turnCompletion: Promise<void> | undefined;
	abortRequested: boolean;
	piSessionId: string | undefined;
	restored: boolean;
}

// TierConnection computes routing metadata for the owned connection's session
// methods. The owned base connection forwards it through standard ACP requests.
interface OmpRoutedConnection {
	toolRouting?: { nativeTools: NativeToolMode; channel: "pending" | "system-append" | "legacy-prompt" };
	setOmpSystemInstructions?: (text: string) => void;
	setOmpSessionKind?: (kind: SessionRoutingKind) => void;
	setOmpContextWindow?: (sessionId: string, contextWindow: number) => void;
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || ancestors.has(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return false;
	// Track the current recursion path only: the same object may appear twice in
	// valid JSON data (encoding duplicates it), while a cycle must fail.
	ancestors.add(value);
	const valid = Array.isArray(value)
		? value.every(item => isJsonValue(item, ancestors))
		: Object.values(value).every(item => isJsonValue(item, ancestors));
	ancestors.delete(value);
	return valid;
}

function normalizeBoundaryContentBlock(block: unknown): Array<TextContent | ToolCall> {
	if (typeof block !== "object" || block === null) return [];
	const type = Reflect.get(block, "type");
	if (type === "text") {
		const text = Reflect.get(block, "text");
		return typeof text === "string" && text.length > 0 ? [{ type: "text", text }] : [];
	}
	if (type === "toolCall") {
		const id = Reflect.get(block, "id"), name = Reflect.get(block, "name"), args = Reflect.get(block, "arguments");
		if (typeof id !== "string" || typeof name !== "string" || !isJsonValue(args) || typeof args !== "object" || args === null || Array.isArray(args)) return [];
		return [{ type: "toolCall", id, name, arguments: args }];
	}
	return [];
}

function ompRoutingChannel(connection: AntigravityAcpConnection): OmpRoutedConnection["toolRouting"] {
	return (connection as AntigravityAcpConnection & OmpRoutedConnection).toolRouting;
}

export interface PermissionView {
	id: string;
	title: string;
	options: Array<{ id: string; label: string; kind: string }>;
}

export interface ManualGoogleLoginInteraction {
	showAuthorizationUrl: (url: string, instructions: string) => void;
	promptForCallback: (signal: AbortSignal) => Promise<string>;
}

export interface PermissionToolResult {
	kind: typeof PERMISSION_RESULT_KIND;
	requestId: string;
	optionId?: string;
	cancelled: boolean;
}

export interface RuntimeSnapshot {
	bindings: number;
	permissionMode: PermissionMode;
	metrics: ReturnType<RuntimeMetrics["snapshot"]>;
	processes: Array<{
		key: string;
		role: "main" | "shadow";
		shadow?: { kind: ShadowCheckpoint["kind"]; absorbed?: number };
		pid?: number;
		generation: number;
		sessionId: string;
		modelId: string;
		confirmedPermissionMode: PermissionMode;
		omittedTools: ToolOmission[];
		alive: boolean;
		waitingForPermission: boolean;
		waitingForTools: number;
		agentVersion: string | undefined;
		mcpHttp: boolean;
		restored: boolean;
		ignoredStdoutNoiseLines: number;
		stderrTail?: string;
	}>;
}

export type AntigravityConnectionFactory = (options: AntigravityConnectionOptions) => AntigravityAcpConnection;

export class AntigravityRuntime {
          private readonly ompSystemMemo = createStructuredFingerprintMemo();
          private readonly ompToolsMemo = createStructuredFingerprintMemo();
          private ompMessagesFingerprint(messages: Context["messages"]): string { return messagesFingerprint(messages, this.ompSystemMemo); }
          private ompMessageFingerprint(message: Context["messages"][number]): string { return messageFingerprint(message, this.ompSystemMemo); }
          private ompToolsFingerprint(tools: NonNullable<Context["tools"]>): string { return this.ompToolsMemo(tools, () => piToolFingerprint(tools)); }
          private ompRelayConfig() {
            const base = resolveRelayConfig();
            return this.ompRelayThresholdMs === undefined
              ? base
              : { ...base, thresholdMs: this.ompRelayThresholdMs, fingerprint: `${base.fingerprint}:test:${this.ompRelayThresholdMs}` };
          }
          private ompRelayCollision(tools: NonNullable<Context["tools"]>): string | undefined {
            if (!this.ompRelayConfig().enabled) return undefined;
            return tools.find(tool => projectedMcpName(tool.name) === TOOL_RELAY_CONTROL_NAME)?.name;
          }
          private ompCanSyncTools(binding: Binding, tools: NonNullable<Context["tools"]>): boolean {
            if (binding.relayFingerprint !== this.ompRelayConfig().fingerprint) return false;
            const nextFp = this.ompToolsFingerprint(tools);
            if (binding.toolFingerprint === nextFp) return true;
            if (binding.initialize.agentCapabilities?.mcpCapabilities?.http === true) {
              return binding.bridge !== undefined || tools.length === 0;
            }
            return true;
          }
          private ompSyncTools(binding: Binding, tools: NonNullable<Context["tools"]>): void {
            const relayCollision = this.ompRelayCollision(tools);
            if (relayCollision) throw new AntigravityAcpError("invalid_input", "Tool " + relayCollision + " collides with the relay control tool " + TOOL_RELAY_CONTROL_NAME + "; rename it or disable OMP_ACP_TOOL_RELAY_MS");
            const nextFp = this.ompToolsFingerprint(tools);
            if (binding.toolFingerprint === nextFp) return;
            if (binding.bridge) {
              binding.bridge.updateTools(tools);
              binding.omittedTools = [...binding.bridge.omissions];
            } else {
              binding.omittedTools = binding.initialize.agentCapabilities?.mcpCapabilities?.http === true
                ? planToolProjection(tools)
                : tools.filter((tool) => tool.name !== PERMISSION_TOOL_NAME).map((tool) => ({ name: tool.name, reason: "Agent did not advertise MCP over HTTP" }));
            }
            binding.toolFingerprint = nextFp;
            binding.relayFingerprint = this.ompRelayConfig().fingerprint;
          }
          private ompNormalizeAssistantForBoundary(message: Context["messages"][number]): Context["messages"][number] {
            if (message.role !== "assistant") return message;
            const raw: unknown = Reflect.get(message, "content");
            const blocks = typeof raw === "string" ? [{ type: "text", text: raw }]
              : Array.isArray(raw) ? raw : [];
            const filtered = blocks.flatMap(normalizeBoundaryContentBlock);
            return {
              ...message,
              role: "assistant",
              provider: "antigravity-acp",
              model: "",
              content: filtered.length ? filtered : [{ type: "text", text: "" }],
            };
          }
          private ompAssistantMatches(binding: Binding, message: Context["messages"][number] | undefined): boolean {
            if (!message || message.role !== "assistant" || !binding.expectedAssistantFingerprint) return false;
            if (this.ompMessageFingerprint(message) === binding.expectedAssistantFingerprint) return true;
            // Older checkpoints predate the normalized fingerprint. Without a
            // trusted expected value, never compare a message with itself.
            if (!binding.ompExpectedAssistantNormalized) return false;
            return this.ompMessageFingerprint(this.ompNormalizeAssistantForBoundary(message)) === binding.ompExpectedAssistantNormalized;
          }

	private readonly bindings = new Map<string, Promise<Binding>>();
	private readonly resolvedBindings = new Set<Binding>();
	private disposed = false;
	private closePromise: Promise<void> | undefined;
	private bindingEpoch = 0;
	private readonly activeConnections = new Set<AntigravityAcpConnection>();
	private readonly queues = new Map<string, Promise<void>>();
	private modeChanges = Promise.resolve();

	private readonly connectionFactory: AntigravityConnectionFactory;
	private readonly ensureAgent: boolean;
	private readonly sessionStore: AcpSessionStore | undefined;
	private readonly metrics = new RuntimeMetrics();
	private permissionMode: PermissionMode;
	private readonly ompRelayThresholdMs: number | undefined;
	private quotaCache: AntigravityQuotaSnapshot | undefined;
	private quotaCacheOwner: string | undefined;
	private readonly quotaInFlights = new Set<OmpQuotaRequest>();

	constructor(
		connectionFactory?: AntigravityConnectionFactory,
		permissionMode: PermissionMode = "yolo",
		sessionStore?: AcpSessionStore,
		relayThresholdMs?: number,
	) {
		this.ompRelayThresholdMs = relayThresholdMs;
		this.connectionFactory = connectionFactory ?? ((options) => new AntigravityAcpConnection(options));
		this.ensureAgent = connectionFactory === undefined;
		this.permissionMode = permissionMode;
		this.sessionStore = sessionStore ?? (this.ensureAgent ? new AcpSessionStore() : undefined);
	}

	stream(model: AntigravityModel, context: Context, options: OmpStreamOptions = {}): PiEventWriter {
		const writer = new PiEventWriter(model);
		// ACP has no mid-conversation system-message API. Replay Pi's prompt/tool
		// deltas into a checkpoint; its fingerprint invalidates stale warm sessions.
		try {
			const transcript = collapseSystemMessages(normalizeContext(context));
			const resolvedContext: Context = {
				messages: transcript.messages,
				systemPrompt: getCurrentSystemPrompt(transcript.messages),
				tools: getCurrentTools(transcript.messages),
			};
			currentSystemInstructions(resolvedContext);
			const route = resolveSessionRoute(options.sessionId, options.parentSessionId);
			const dispatch = route.kind === "shadow"
				? this.runShadow(route, model, resolvedContext, options, writer)
				: this.runQueued(model, resolvedContext, options, writer);
			void dispatch.catch((error: unknown) => {
				writer.fail(error, options.signal?.aborted === true || isAbort(error));
			});
		} catch (error) {
			writer.fail(error, options.signal?.aborted === true || isAbort(error));
		}
		return writer;
	}

	async discoverModels(apiKey: string | undefined, signal?: AbortSignal): Promise<AcpModelInfo[]> {
		this.assertActive();
		const epoch = this.bindingEpoch;
		if (signal?.aborted) throw abortError();
		if (this.ensureAgent) await ensureAntigravityAcpReady();
		if (signal?.aborted) throw abortError();
		this.assertEpoch(epoch);
		const connection = this.createConnection({ cwd: process.cwd() });
		try {
			const initialize = await connection.initialize(signal);
			this.assertEpoch(epoch);
			await authenticateForCredential(connection, initialize, apiKey, signal);
			this.assertEpoch(epoch);
			const session = await connection.newSession(process.cwd(), signal);
			try { this.assertEpoch(epoch); return sessionModels(session)?.availableModels ?? []; } finally { await connection.discardSession?.(session.sessionId); }
		} finally {
			await connection.close();
		}
	}

	async quota(apiKey: string | undefined, signal?: AbortSignal): Promise<AntigravityQuotaSnapshot> {
		this.assertActive();
		if (signal?.aborted) throw abortError();
		const owner = apiKey === undefined ? "managed" : `key:${createHash("sha256").update(apiKey).digest("hex")}`;
		if (this.quotaCacheOwner === owner && this.quotaCache && Date.now() - this.quotaCache.at < 60_000) return this.quotaCache;
		const epoch = this.bindingEpoch;
		let request = [...this.quotaInFlights].find(candidate => candidate.epoch === epoch && candidate.owner === owner && !candidate.controller.signal.aborted);
		if (!request) {
			const controller = new AbortController();
			let created!: OmpQuotaRequest;
			const snapshot = this.ompFetchQuota(apiKey, controller.signal).then(value => {
				if (this.bindingEpoch === epoch && !this.disposed && !controller.signal.aborted) {
					this.quotaCache = value;
					this.quotaCacheOwner = owner;
				}
				return value;
			}).finally(() => { this.quotaInFlights.delete(created); });
			created = { epoch, owner, controller, subscribers: 0, snapshot };
			this.quotaInFlights.add(created);
			request = created;
		}
		const active = request;
		active.subscribers++;
		const { promise, resolve, reject } = Promise.withResolvers<AntigravityQuotaSnapshot>();
		let subscribed = true;
		const finish = (settle: () => void, cancel: boolean) => {
			if (!subscribed) return;
			subscribed = false;
			active.subscribers--;
			signal?.removeEventListener("abort", onAbort);
			settle();
			if (cancel && active.subscribers === 0) active.controller.abort();
		};
		const onAbort = () => finish(() => reject(abortError()), true);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		active.snapshot.then(value => finish(() => resolve(value), false), error => finish(() => reject(error), false));
		return promise;
	}

	// A separate short-lived process never races a user's warm ACP session.
	private async ompFetchQuota(apiKey: string | undefined, signal: AbortSignal): Promise<AntigravityQuotaSnapshot> {
		this.assertActive();
		const epoch = this.bindingEpoch;
		if (this.ensureAgent) await ensureAntigravityAcpReady();
		if (signal.aborted) throw abortError();
		this.assertEpoch(epoch);
		let sessionId: string | undefined;
		let text = "";
		const quotaOptions = { cwd: process.cwd(), ompPurpose: "quota" as const };
		const connection = this.createConnection({
			...quotaOptions,
			promptIdleTimeoutMs: 30_000,
			handlers: {
				onUpdate: ({ sessionId: id, update }) => {
					if (id === sessionId && update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") text += update.content.text;
				},
				onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
			},
		});
		try {
			const initialize = await connection.initialize(signal);
			this.assertEpoch(epoch);
			await authenticateForCredential(connection, initialize, apiKey, signal);
			this.assertEpoch(epoch);
			const session = await connection.newSession(process.cwd(), signal);
			sessionId = session.sessionId;
			this.assertEpoch(epoch);
			const currentModel = sessionModels(session)?.currentModelId;
			if (currentModel) {
				await connection.setModel(sessionId, currentModel, signal);
				this.assertEpoch(epoch);
			}
			const advertised = "waitForUsageCommand" in connection && typeof connection.waitForUsageCommand === "function" && await connection.waitForUsageCommand(sessionId, undefined, signal);
			if (signal.aborted) throw abortError();
			if (!advertised) {
				throw new Error("Antigravity /usage was not advertised by this ACP runtime. No model prompt was sent.");
			}
			if (signal.aborted) throw abortError();
			const request = { sessionId, prompt: [{ type: "text" as const, text: "/usage" }] };
			const response = await ("promptWithoutUsageDeltas" in connection && typeof connection.promptWithoutUsageDeltas === "function" ? connection.promptWithoutUsageDeltas(request, signal) : connection.prompt(request, signal));
			if (response.stopReason !== "end_turn") {
				throw new AntigravityAcpError("protocol", `Antigravity /usage stopped with reason ${response.stopReason}; its partial quota response was not parsed`);
			}
			if (signal.aborted) throw abortError();
			return parseUsageQuota(text);
		} finally {
			try { if (sessionId) await connection.discardSession?.(sessionId); } finally { await connection.close(); }
		}
	}

	async loginGoogle(
		signal?: AbortSignal,
		onProgress?: (message: string) => void,
		manualInteraction?: ManualGoogleLoginInteraction,
	): Promise<void> {
		this.assertActive();
		const epoch = this.bindingEpoch;
		if (this.ensureAgent) await ensureAntigravityAcpReady(onProgress);
		this.assertEpoch(epoch);
		const useManualOAuth = manualInteraction !== undefined && shouldUseHeadlessOAuth();
		const relay = useManualOAuth ? new HeadlessOAuthRelay() : undefined;
		const connection = this.createConnection({
			cwd: process.cwd(),
			...(relay ? { env: relay.env } : {}),
		});
		try {
			const initialize = await connection.initialize();
			this.assertEpoch(epoch);
			const method = initialize.authMethods?.find((candidate) =>
				/log\s*in\s+with\s+google|google\s+account|oauth-personal/iu.test(
					`${candidate.id} ${candidate.name}`,
				),
			);
			if (!method) throw new AntigravityAcpError("auth", "Antigravity ACP did not advertise Google login");
			const authentication = connection.authenticate(
				{ methodId: method.id },
				signal,
				relay ? 10 * 60_000 : undefined,
			);
			void authentication.catch(() => undefined);
			if (relay && manualInteraction) {
				const captured = await raceAuthentication(relay.waitForAuthorization(signal), authentication);
				if (captured.authenticated) {
					onProgress?.("Antigravity reused the saved Google login.");
				} else {
					const instructions =
						"Open this URL in a browser on your local machine. After Google redirects to localhost, the page may fail to load; copy the complete localhost URL from the browser address bar and paste it below.";
					manualInteraction.showAuthorizationUrl(captured.value.url, instructions);
					const promptController = new AbortController();
					let entered: Awaited<ReturnType<typeof raceAuthentication<string>>>;
					try {
						entered = await raceAuthentication(
							manualInteraction.promptForCallback(promptController.signal),
							authentication,
						);
					} catch (error) {
						promptController.abort();
						throw error;
					}
					if (entered.authenticated) {
						promptController.abort();
					} else {
						await relay.forwardCallback(entered.value, captured.value, signal);
					}
				}
			}
			await authentication;
			this.assertEpoch(epoch);
			const session = await connection.newSession(process.cwd(), signal);
			try { this.assertEpoch(epoch); } finally { await connection.discardSession?.(session.sessionId); }
			this.assertEpoch(epoch);
		} finally {
			relay?.dispose();
			await connection.close();
		}
	}

	async verifyApiKey(
		apiKey: string,
		signal?: AbortSignal,
		onProgress?: (message: string) => void,
	): Promise<void> {
		this.assertActive();
		const epoch = this.bindingEpoch;
		if (this.ensureAgent) await ensureAntigravityAcpReady(onProgress);
		this.assertEpoch(epoch);
		const connection = this.createConnection({ cwd: process.cwd() });
		try {
			const initialize = await connection.initialize();
			this.assertEpoch(epoch);
			await authenticateForCredential(connection, initialize, apiKey, signal);
			this.assertEpoch(epoch);
			const session = await connection.newSession(process.cwd(), signal);
			try { this.assertEpoch(epoch); } finally { await connection.discardSession?.(session.sessionId); }
			this.assertEpoch(epoch);
		} finally {
			await connection.close();
		}
	}

	async authHealth(apiKey?: string): Promise<AntigravityAuthHealth & { networkValid?: boolean; error?: string }> {
		const local = inspectAntigravityAuth();
		try {
			await this.discoverModels(apiKey ?? (hasUsableLocalAuth(local) ? MANAGED_AUTH_MARKER : undefined));
			return { ...local, networkValid: true };
		} catch (error) {
			return { ...local, networkValid: false, error: errorMessage(error) };
		}
	}

	async logout(): Promise<void> {
		this.disposed = true;
		this.quotaCache = undefined;
		this.quotaCacheOwner = undefined;
		await this.closeBindings();
		await this.sessionStore?.clear();
		clearAntigravityCredentials();
	}

	setPermissionMode(mode: PermissionMode): Promise<void> {
		const change = this.modeChanges.then(async () => {
			this.assertActive();
			this.permissionMode = mode;
			await Promise.all([...this.resolvedBindings].map(async (binding) => {
				if (binding.mode === mode && this.confirmedMode(binding) === mode) return;
				// A side channel cannot update its policy in place; it rebuilds on
				// the next question instead of prompting under a stale mode.
				if (binding.route.kind === "shadow") { await this.invalidateBinding(binding); return; }
				// Never change policy under an executing turn or leave an unsupported session alive.
				if (!binding.turnCompletion && supportsMode(binding.connection.getSessionState(binding.session.sessionId), mode)) {
					try {
						await binding.connection.setMode(binding.session.sessionId, mode);
						if (this.confirmedMode(binding) === mode) { binding.mode = mode; return; }
					} catch { /* Close below; the next turn must negotiate again. */ }
				}
				await this.invalidateBinding(binding);
			}));
		});
		this.modeChanges = change.catch(() => undefined);
		return change;
	}

	getPermission(requestId: string): PermissionView | undefined {
		for (const binding of this.resolvedBindings) {
			if (binding.permission?.id === requestId) return permissionView(binding.permission);
		}
		return undefined;
	}

	async snapshot(includeStderr = false): Promise<RuntimeSnapshot> {
		const entries = [...this.bindings.entries()];
		const processes = await Promise.all(
			entries.map(async ([key, pending]) => {
				const binding = await pending;
				const pid = binding.connection.process.pid;
				return {
					key,
					role: binding.route.kind,
					...(binding.shadow ? { shadow: { kind: binding.shadow.kind, ...(binding.shadow.kind === "clean" ? { absorbed: binding.shadow.absorbed } : {}) } } : {}),
					...(pid === undefined ? {} : { pid }),
					generation: binding.connection.process.generation,
					sessionId: binding.session.sessionId,
					modelId: binding.modelId,
					confirmedPermissionMode: binding.mode,
					omittedTools: binding.omittedTools,
					alive: binding.connection.process.alive,
					waitingForPermission: binding.permission !== undefined,
					waitingForTools: binding.pendingTools.size,
					agentVersion: binding.initialize.agentInfo?.version,
					mcpHttp: binding.initialize.agentCapabilities?.mcpCapabilities?.http === true,
					restored: binding.restored,
					ignoredStdoutNoiseLines: binding.connection.process.ignoredStdoutNoiseLines,
					...(includeStderr ? { stderrTail: binding.connection.process.stderrTail } : {}),
				};
			}),
		);
		return {
			bindings: processes.length,
			permissionMode: this.permissionMode,
			metrics: this.metrics.snapshot(),
			processes,
		};
	}

	close(): Promise<void> {
		this.disposed = true;
		return this.closePromise ??= this.closeBindings();
	}

	private async closeBindings(): Promise<void> {
 for (const request of this.quotaInFlights) request.controller.abort(); const closingTurns = [...this.resolvedBindings].flatMap(binding => binding.turnCompletion ? [binding.turnCompletion] : []);
 const ephemeralBindings = [...this.resolvedBindings].filter(binding => !binding.piSessionId);
 await Promise.allSettled(ephemeralBindings.map(async binding => await this.discardBindingSession(binding)));
		this.bindingEpoch += 1;
		const pending = [...this.bindings.values()];
		this.bindings.clear();
		for (const binding of this.resolvedBindings) {
			cancelPermission(binding);
			cancelPiTools(binding, "Provider shut down before Pi returned the tool result");
		}
		this.resolvedBindings.clear();
		// Includes authentication/discovery and sessions still initializing, not just warm bindings.
		await Promise.allSettled([...this.activeConnections].map((connection) => connection.close()));
		await Promise.allSettled(
			pending.map(async (binding) => {
				const value = await binding;
				await Promise.allSettled([
					value.connection.close(),
					value.bridge?.close() ?? Promise.resolve(),
				value.relayBridge?.close() ?? Promise.resolve(),
				]);
			}),
		);
		await Promise.allSettled(closingTurns);
		await Promise.allSettled(pending.map(async value => (await value).ompReleaseLease?.()));
		try { await this.sessionStore?.flush?.(); } finally { this.ompSystemMemo.clear(); this.ompToolsMemo.clear(); }
	}

	private async runQueued(
		model: AntigravityModel,
		context: Context,
		options: SimpleStreamOptions,
		writer: PiEventWriter,
	): Promise<void> {
		this.assertActive();
		const epoch = this.bindingEpoch;
		if (this.ensureAgent) await ensureAntigravityAcpReady();
		await this.modeChanges;
		this.assertEpoch(epoch);
		const mainRoute: SessionRoute = { kind: "main", routingId: options.sessionId ?? "" };
		const persistent = Boolean(options.sessionId);
		const key = options.sessionId
			? `sid:${options.sessionId}`
			: (this.findContinuationKey(context) ?? `ephemeral:${crypto.randomUUID()}`);
		const tools = context.tools ?? [];
		const instructions = currentSystemInstructions(context);
		const acpModelId = resolveAcpModelId(model, options.reasoning);
		let binding = await this.getBinding(key, mainRoute, model, acpModelId, options.apiKey, writer, tools, instructions, options.signal);
		if (binding.ompCompactionInvalidated) {
			await this.invalidateBinding(binding);
			binding = await this.getBinding(key, mainRoute, model, acpModelId, options.apiKey, writer, tools, instructions, options.signal);
		}
		await this.modeChanges;
		this.assertEpoch(epoch);
		// Check before continuation early returns as well as before fresh prompts.
		const ompContinuation = Boolean(binding.turnCompletion) && (binding.permission !== undefined || binding.pendingTools.size > 0);
		if (binding.cwd !== process.cwd() ||
			(binding.turnCompletion && binding.modelId !== acpModelId) ||
			binding.mode !== this.permissionMode || this.confirmedMode(binding) !== this.permissionMode ||
			(!ompContinuation && !this.ompCanSyncTools(binding, tools))) {
			await this.invalidateBinding(binding);
			binding = await this.getBinding(key, mainRoute, model, acpModelId, options.apiKey, writer, tools, instructions, options.signal);
		}
		if (!ompContinuation) this.ompSyncTools(binding, tools);

		// A new/edited user request is not a tool-result continuation of the
		// previous ACP prompt. Never let old pending results swallow it.
		if (binding.turnCompletion || binding.permission || binding.pendingTools.size > 0) {
			const ompPrefixMessages = context.messages.slice(0, binding.pendingContextCount);
			const ompPrefixFingerprint = this.ompMessagesFingerprint(ompPrefixMessages);
			const ompConversationPrefixFingerprint = this.ompMessagesFingerprint(ompPrefixMessages.filter(message => message.role !== 'system'));
			const ompNewUser = context.messages.findLastIndex(message => message.role === 'user') >= binding.pendingContextCount;
			const ompPrefixChanged = ompPrefixFingerprint !== binding.pendingContextFingerprint;
			const ompConversationPrefixChanged = binding.pendingConversationFingerprint === undefined ? ompPrefixChanged : ompConversationPrefixFingerprint !== binding.pendingConversationFingerprint;
			if (ompNewUser || ompConversationPrefixChanged) {
				const prefixMatches = context.messages.length >= binding.pendingContextCount &&
					(!ompPrefixChanged || (binding.pendingConversationFingerprint !== undefined &&
						ompConversationPrefixFingerprint === binding.pendingConversationFingerprint &&
						binding.instructionsFingerprint !== undefined && binding.instructionsFingerprint === instructionFingerprint(context)));
				// Queue mode can safely wait only for a streaming turn with no
				// parked tool/permission; those need the existing steer drain.
				const ompQueueSteer = steerMode() === 'queue' &&
					Boolean(binding.turnCompletion) && !binding.permission && binding.pendingTools.size === 0 && !binding.ompSeeding;
				if (ompQueueSteer) {
					if (prefixMatches) binding.connection.muteSteerChunks?.(binding.session.sessionId);
				} else {
					const drained = prefixMatches && await drainCancelledTurn(binding, () => abortTurn(binding), options.signal);
					if (!drained || !binding.connection.process.alive || binding.needsReconstruction ||
						!['cancelled', 'end_turn', 'max_turn_requests', 'max_tokens'].includes(binding.ompTerminalStopReason)) {
						await this.invalidateBinding(binding);
					}
					if (drained && prefixMatches) {
						this.ompSyncTools(binding, tools);
						binding.historyFingerprint = this.ompMessagesFingerprint(context.messages.slice(0, binding.messageCount));
					}
					binding = await this.getBinding(key, mainRoute, model, acpModelId, options.apiKey, writer, tools, instructions, options.signal);
				}
			}
		}

		if (binding.turnCompletion && !binding.abortRequested &&
			context.messages.length === binding.pendingContextCount &&
			this.ompMessagesFingerprint(context.messages) === binding.pendingContextFingerprint) {
			throw new AntigravityAcpError('invalid_input', 'ACP request/continuation is already in progress for this session');
		}
		// A permission tool result resumes the still-running ACP prompt rather than
		// starting a second Antigravity turn.
		if (binding.permission) {
			const pending = binding.permission;
			const result = findPermissionResult(context, pending.id);
			if (!result) {
				cancelPermission(binding);
				await this.invalidateBinding(binding);
				binding = await this.getBinding(key, mainRoute, model, acpModelId, options.apiKey, writer, tools, instructions, options.signal);
			} else {
				await claimContinuation(binding, async () => {
				binding.writer = writer;
				const continuationTurn = binding.turnCompletion; await this.noteContinuationInstructions(binding, context); if (!continuationTurn || binding.turnCompletion !== continuationTurn || binding.abortRequested || options.signal?.aborted || !binding.connection.process.alive) throw abortError();
				binding.pendingContextCount = context.messages.length;
				binding.pendingContextFingerprint = this.ompMessagesFingerprint(context.messages);
			binding.pendingConversationFingerprint = this.ompMessagesFingerprint(context.messages.filter(message => message.role !== 'system'));
				binding.permission = undefined;
				clearTimeout(pending.timer);
				binding.ompFallbackContextTokens = estimateContextTokens(context);
				if (
					!result.cancelled &&
					result.optionId &&
					pending.request.options.some((option) => option.optionId === result.optionId)
				) {
					pending.resolve({ outcome: { outcome: "selected", optionId: result.optionId } });
				} else {
					pending.resolve({ outcome: { outcome: "cancelled" } });
				}
				}, () => this.invalidateBinding(binding));
				this.ompSyncTools(binding, tools);
				await this.awaitContinuation(binding, options.signal);
				return;
			}
		}

		if (binding.pendingTools.size > 0) {
			const results = [...binding.pendingTools.values()].map((pending) => ({
				pending,
				message: findToolResult(context, pending.invocation.id, pending.invocation.name),
			}));
			if (results.some((result) => result.message === undefined)) {
				cancelPiTools(binding, "Pi continued without returning every requested tool result");
				await this.invalidateBinding(binding);
				binding = await this.getBinding(key, mainRoute, model, acpModelId, options.apiKey, writer, tools, instructions, options.signal);
			} else if (!binding.turnCompletion) {
				cancelPiTools(binding, "The previous ACP turn ended before the relayed tool result arrived; the result will be replayed as history in a new continuation");
				binding.pendingTools.clear();
				binding.needsReconstruction = true;
			} else {
				await claimContinuation(binding, async () => {
				binding.writer = writer;
				const continuationTurn = binding.turnCompletion; await this.noteContinuationInstructions(binding, context); if (!continuationTurn || binding.turnCompletion !== continuationTurn || binding.abortRequested || options.signal?.aborted || !binding.connection.process.alive) throw abortError();
				binding.pendingContextCount = context.messages.length;
				binding.pendingContextFingerprint = this.ompMessagesFingerprint(context.messages);
			binding.pendingConversationFingerprint = this.ompMessagesFingerprint(context.messages.filter(message => message.role !== 'system'));
				binding.ompFallbackContextTokens = estimateContextTokens(context);
				for (const { pending, message } of results) {
					binding.pendingTools.delete(pending.invocation.id);
					pending.resolve(toMcpToolResult(message as ToolResultMessage));
				}
				}, () => this.invalidateBinding(binding));
				this.ompSyncTools(binding, tools);
				await this.awaitContinuation(binding, options.signal);
				return;
			}
		}

		const ompQueuedBehindTurn = this.queues.has(key);
		const previous = this.queues.get(key) ?? Promise.resolve();
		let release!: () => void;
		const queue = new Promise<void>((resolve) => { release = resolve; });
		this.queues.set(key, queue);
		await previous;

		let ompDispatched = false;
		let completeTurn: (() => void) | undefined;
		let onTurnAbort: (() => void) | undefined;
		try {
			await this.modeChanges;
			this.assertEpoch(epoch);
			// A queued caller may hold an obsolete binding after shutdown/mode changes.
			binding = await this.getBinding(key, mainRoute, model, acpModelId, options.apiKey, writer, tools, instructions, options.signal);
			if (ompQueuedBehindTurn && binding.modelId === acpModelId && !binding.ompCancelledCheckpoint && binding.expectedAssistantFingerprint &&
				context.messages.length === binding.messageCount &&
				this.ompMessagesFingerprint(context.messages) === binding.historyFingerprint) {
				throw new AntigravityAcpError('invalid_input', 'ACP request was already processed by the preceding turn; refusing duplicate dispatch');
			}
			if (this.ompCanSyncTools(binding, tools)) this.ompSyncTools(binding, tools);
			if (!binding.needsReconstruction && context.messages.length >= binding.messageCount &&
				this.ompMessagesFingerprint(context.messages.slice(0, binding.messageCount)) !== binding.historyFingerprint &&
				context.messages.slice(0, binding.messageCount).some(message => message.role === 'system') &&
				binding.instructionsFingerprint !== undefined && binding.instructionsFingerprint === instructionFingerprint(context) &&
				binding.ompConversationFingerprint !== undefined &&
				this.ompMessagesFingerprint(context.messages.slice(0, binding.messageCount).filter(message => message.role !== 'system')) === binding.ompConversationFingerprint) {
				binding.historyFingerprint = this.ompMessagesFingerprint(context.messages.slice(0, binding.messageCount));
			}
			// Only after accepting a non-textual system/tool delta can an
			// identical resend be recognized against the updated checkpoint.
			const ompRetryResend = binding.messageCount > 0 &&
				context.messages.length === binding.messageCount &&
				this.ompMessagesFingerprint(context.messages) === binding.historyFingerprint;
			if (
				binding.needsReconstruction || binding.cwd !== process.cwd() ||
				(binding.instructionsFingerprint !== undefined && binding.instructionsFingerprint !== instructionFingerprint(context)) ||
				(binding.expectedAssistantFingerprint && context.messages[binding.messageCount]?.role === 'assistant' &&
					!this.ompAssistantMatches(binding, context.messages[binding.messageCount])) ||
				((binding.ompExpectedAssistantHasOutput || (binding.ompCancelledCheckpoint && binding.ompCancelledHadOutput)) &&
					context.messages[binding.messageCount]?.role !== 'assistant' && !ompRetryResend) || binding.mode !== this.permissionMode ||
				this.confirmedMode(binding) !== this.permissionMode ||
				!this.ompCanSyncTools(binding, tools) ||
				context.messages.length < binding.messageCount ||
				this.ompMessagesFingerprint(context.messages.slice(0, binding.messageCount)) !==
					binding.historyFingerprint
			) {
				await this.dropBinding(key, binding, true);
				binding = await this.getBinding(key, mainRoute, model, acpModelId, options.apiKey, writer, tools, instructions, options.signal);
			}
			binding.writer = writer;
			if (binding.modelId !== acpModelId) {
				try {
					await binding.connection.setModel(binding.session.sessionId, acpModelId, options.signal);
				} catch (error) {
					await this.invalidateBinding(binding);
					throw error;
				}
				binding.modelId = acpModelId;
				(binding.connection as AntigravityAcpConnection & OmpRoutedConnection).setOmpContextWindow?.(binding.session.sessionId, model.contextWindow);
			}

			const fresh = binding.messageCount === 0;
			let unseenStart = binding.messageCount;
			const expected = context.messages[unseenStart];
			if (
				!fresh &&
				expected?.role === "assistant" &&
				this.ompAssistantMatches(binding, expected)
			) {
				unseenStart += 1;
			}
			// Only the seam that actually applied the append channel may omit the
			// instructions resource. An unconfigured connection keeps the legacy
			// resource even when the agent advertises append support.
			const routing = ompRoutingChannel(binding.connection);
			const sessionAppend = routing?.channel === "system-append";
			const bridgeConfigured = binding.initialize.agentCapabilities?.mcpCapabilities?.http === true &&
				binding.bridge !== undefined && !binding.bridge.empty;
			const sessionGuidance = sessionAppend
				? undefined
				: ompToolGuidance(binding.initialize, routing?.nativeTools ?? "prefer", bridgeConfigured);
			const parts = adaptPromptToCapabilities(
				buildPromptParts(context, fresh, unseenStart, { contextWindow: model.contextWindow, maxTokens: model.maxTokens, policy: model.ompContextPolicy, sessionRouting: sessionAppend, sessionGuidance }, ompRetryResend),
				binding.initialize,
			);
			await this.modeChanges;
			this.assertEpoch(epoch);
			if (binding.mode !== this.permissionMode || this.confirmedMode(binding) !== this.permissionMode || !binding.connection.process.alive) {
				await this.invalidateBinding(binding);
				throw new AntigravityAcpError("protocol", "Permission mode changed before prompting; retry the turn");
			}
			binding.ompTerminalStopReason = undefined;
			binding.instructionsFingerprint = instructionFingerprint(context);
			binding.ompFallbackContextTokens = parts.estimatedContextTokens;
			binding.needsReconstruction = false;
			binding.pendingContextCount = context.messages.length;
			binding.pendingContextFingerprint = this.ompMessagesFingerprint(context.messages);
			binding.pendingConversationFingerprint = this.ompMessagesFingerprint(context.messages.filter(message => message.role !== 'system'));
			binding.relay.beginTurn();
			binding.turnCompletion = new Promise<void>((resolve) => {
				completeTurn = resolve;
			});
			if (options.signal) {
				const promptBinding = binding;
				onTurnAbort = () => {
					if (steerMode() === 'queue' && isSteerAbort(options.signal) && !promptBinding.ompSeeding) {
						promptBinding.connection.muteSteerChunks?.(promptBinding.session.sessionId);
					} else abortTurn(promptBinding);
				};
				options.signal.addEventListener("abort", onTurnAbort, { once: true });
				if (options.signal.aborted) onTurnAbort();
			}
			if (options.signal?.aborted) throw abortError();
            binding.ompInFlight = true;
            await this.persistBinding(binding);
            this.assertEpoch(epoch);
            if (binding.ompInvalidated || !binding.connection.process.alive) throw new AntigravityAcpError('protocol', 'ACP session closed before prompt dispatch');
            if (options.signal?.aborted) throw abortError();
            ompDispatched = true;
            let ompSeedUsage;
            if (parts.seedSteps?.length) {
              const savedWriter = binding.writer;
              binding.writer = undefined;
              binding.ompSeeding = true;
              try {
                for (const seedPrompt of parts.seedSteps) {
                  binding.ompSeedText = '';
                  if (options.signal?.aborted || binding.abortRequested) throw abortError();
                  const seedResponse = await binding.connection.prompt({ sessionId: binding.session.sessionId, prompt: seedPrompt }, options.signal);
                  if (binding.ompInvalidated) throw new AntigravityAcpError('protocol', 'ACP session ownership was lost');
                  if (binding.abortRequested || seedResponse.stopReason === 'cancelled' || options.signal?.aborted) throw abortError();
                  const seedQuota = quotaExhaustion(binding.ompSeedText ?? '');
                  binding.ompSeedText = undefined;
                  if (seedQuota) await this.ompThrowQuota(binding, seedQuota);
                  if (seedResponse.stopReason !== 'end_turn') throw new AntigravityAcpError('protocol', `ACP seed step stopped early with ${seedResponse.stopReason}`);
                  const seedUsage = usageFromPrompt(seedResponse);
                  if (ompSeedUsage) {
                    ompSeedUsage.input += seedUsage.input;
                    ompSeedUsage.output += seedUsage.output;
                    ompSeedUsage.cacheRead += seedUsage.cacheRead;
                    ompSeedUsage.cacheWrite += seedUsage.cacheWrite;
                    ompSeedUsage.totalTokens += seedUsage.totalTokens;
                    ompSeedUsage.reasoning = (ompSeedUsage.reasoning ?? 0) + (seedUsage.reasoning ?? 0);
                  } else ompSeedUsage = seedUsage;
                }
                binding.ompSeeding = false;
              } finally {
                binding.writer = savedWriter;
              }
            }
            const response = await binding.connection.prompt(
				{ sessionId: binding.session.sessionId, prompt: parts.prompt },
				options.signal,
			);
			if (onTurnAbort) options.signal?.removeEventListener("abort", onTurnAbort);
			const activeWriter = binding.writer ?? writer;
			if (binding.ompInvalidated) throw new AntigravityAcpError('protocol', 'ACP session ownership was lost');
			binding.ompTerminalStopReason = response.stopReason;
			if (binding.abortRequested) throw abortError();
			const usage = usageFromPrompt(response, binding.ompFallbackContextTokens);
			if (ompSeedUsage) {
				usage.input += ompSeedUsage.input;
				usage.output += ompSeedUsage.output;
				usage.cacheRead += ompSeedUsage.cacheRead;
				usage.cacheWrite += ompSeedUsage.cacheWrite;
				usage.totalTokens += ompSeedUsage.totalTokens;
				if (ompSeedUsage.reasoning !== undefined) usage.reasoning = (usage.reasoning ?? 0) + ompSeedUsage.reasoning;
			}
			activeWriter.message.usage = usage;
			this.metrics.record(response, usage);
			const quota = response.stopReason === "cancelled" ? undefined : quotaExhaustion(activeWriter.message.content.map(block => block.type === "text" ? block.text : "").join(""));
			if (quota) await this.ompThrowQuota(binding, quota);
			activeWriter.message.rawStopReason = response.stopReason;
			binding.messageCount = binding.pendingContextCount || parts.messageCount;
			binding.historyFingerprint = binding.pendingContextFingerprint;
			binding.ompConversationFingerprint = binding.pendingConversationFingerprint;
            binding.expectedAssistantFingerprint = this.ompMessageFingerprint(activeWriter.message.content.length
              ? activeWriter.message : { ...activeWriter.message, content: [{ type: 'text', text: '' }] });
            binding.ompExpectedAssistantNormalized = this.ompMessageFingerprint(this.ompNormalizeAssistantForBoundary(activeWriter.message));
            binding.ompExpectedAssistantHasOutput = activeWriter.message.content.some(block => block.type !== 'text' || block.text.length > 0);
            binding.ompInFlight = false;
			if (response.stopReason !== 'cancelled') binding.ompCancelledCheckpoint = false;
			await this.persistBinding(binding);
			if (response.stopReason === 'end_turn' || (!fresh && (response.stopReason === 'max_tokens' || response.stopReason === 'max_turn_requests'))) { await binding.connection.confirmReplacement?.(key, binding.session.sessionId); }
			if (!persistent) { await binding.connection.discardSession?.(binding.session.sessionId); await this.dropBinding(key, binding); }
			switch (response.stopReason) {
				case "cancelled":
					throw abortError();
				case "refusal":
					throw new AcpFailure("refusal", "Antigravity refused the request");
				case "max_tokens":
				case "max_turn_requests":
					activeWriter.done("length");
					break;
				default:
					activeWriter.done("stop");
			}
		} catch (error) {
			binding.writer?.fail(error, isAbort(error));
			if (isAbort(error) || binding.abortRequested) {
				abortTurn(binding);
				if (binding.connection.process.alive && !binding.ompInvalidated && !binding.needsReconstruction && !binding.ompSeeding &&
					['cancelled', 'end_turn', 'max_turn_requests', 'max_tokens'].includes(binding.ompTerminalStopReason)) {
					const ompWasWarm = binding.messageCount > 0;
					binding.messageCount = binding.pendingContextCount;
					binding.historyFingerprint = binding.pendingContextFingerprint;
					binding.ompConversationFingerprint = binding.pendingConversationFingerprint;
					binding.expectedAssistantFingerprint = this.ompMessageFingerprint((binding.writer ?? writer).message);
					binding.ompExpectedAssistantNormalized = this.ompMessageFingerprint(this.ompNormalizeAssistantForBoundary((binding.writer ?? writer).message));
					binding.ompCancelledCheckpoint = true;
					binding.ompCancelledHadOutput = (binding.writer ?? writer).message.content.length > 0;
					binding.ompExpectedAssistantHasOutput = binding.ompCancelledHadOutput;
					binding.ompInFlight = false;
					try { await this.persistBinding(binding); } catch (checkpointError) { await this.invalidateBinding(binding); throw checkpointError; }
					if (ompWasWarm) await binding.connection.confirmReplacement?.(key, binding.session.sessionId);
				} else await this.invalidateBinding(binding);
			} else if (ompDispatched && !binding.ompInvalidated && error instanceof AntigravityAcpError && error.code === "quota") {
				binding.ompInFlight = false;
				try { await this.persistBinding(binding); } catch (checkpointError) { await this.invalidateBinding(binding); throw checkpointError; }
			} else if (ompDispatched && !binding.ompInvalidated) await this.invalidateBinding(binding);
			else binding.ompInFlight = false;
			if (!binding.connection.process.alive) await this.dropBinding(key, binding);
			throw error;
		} finally {
			if (onTurnAbort) options.signal?.removeEventListener("abort", onTurnAbort);
			completeTurn?.();
			binding.relay.endTurn();
			binding.turnCompletion = undefined;
			binding.ompFallbackContextTokens = undefined;
			binding.abortRequested = false;
			binding.writer = undefined;
			release();
			if (this.queues.get(key) === queue) this.queues.delete(key);
			binding.ompSeeding = false;
			if (!persistent || !binding.connection.process.alive) await this.dropBinding(key, binding);
		}
	}

	// A parent-owned BTW shadow. One connection and ACP session per owning main
	// routing id, seeded once and then reused with prefix deltas.
	private async runShadow(
		route: Extract<SessionRoute, { kind: "shadow" }>,
		model: AntigravityModel,
		context: Context,
		options: OmpStreamOptions,
		writer: PiEventWriter,
	): Promise<void> {
		this.assertActive();
		const epoch = this.bindingEpoch;
		if (this.ensureAgent) await ensureAntigravityAcpReady();
		await this.modeChanges;
		this.assertEpoch(epoch);
		const key = shadowBindingKey(route.parentRoutingId);
		const tools = context.tools ?? [];
		const instructions = currentSystemInstructions(context);
		const acpModelId = resolveAcpModelId(model, options.reasoning);
		const layout = sideLayout(context.messages);
		const instructionsFingerprint = instructionFingerprint(context);

		let binding = await this.getBinding(key, route, model, acpModelId, options.apiKey, writer, tools, instructions, options.signal);
		const current = { modelId: acpModelId, mode: this.permissionMode, instructions: instructionsFingerprint };
		const plan = binding.cwd === process.cwd()
			? planShadowDispatch(binding.shadow, layout, current)
			: { kind: "rebuild", reason: "rewind" } as ShadowPlan;
		if (plan.kind === "rebuild") {
			await this.dropBinding(key, binding, true);
			binding = await this.getBinding(key, route, model, acpModelId, options.apiKey, writer, tools, instructions, options.signal);
		}
		await this.modeChanges;
		this.assertEpoch(epoch);
		if (binding.mode !== this.permissionMode || this.confirmedMode(binding) !== this.permissionMode) {
			await this.invalidateBinding(binding);
			throw new AntigravityAcpError("protocol", "Permission mode changed before prompting; retry the turn");
		}
		if (!binding.connection.process.alive) throw new AntigravityAcpError("protocol", "ACP session closed before prompt dispatch");
		// Two side turns cannot interleave on one shadow session. OMP runs BTW
		// turns one at a time; a duplicate dispatch fails loudly instead of
		// corrupting the shared checkpoint.
		if (binding.turnCompletion) {
			throw new AntigravityAcpError("invalid_input", "ACP side request is already in progress for this conversation");
		}

		// A shadow seed carries the whole supplied side context. Later turns drop
		// the ephemeral scaffold the ACP session already holds and send only what
		// is unseen: main-history growth plus the new question.
		const fresh = plan.kind === "seed" || plan.kind === "rebuild";
		const dispatchContext: Context = fresh ? context : {
			...context,
			messages: [...context.messages.slice(0, layout.mainLength), context.messages[context.messages.length - 1]!],
		};
		const unseenStart = fresh ? 0 : plan.kind === "delta" ? plan.unseenStart : dispatchContext.messages.length;
		const routing = ompRoutingChannel(binding.connection);
		const sessionAppend = routing?.channel === "system-append";
		const bridgeConfigured = binding.initialize.agentCapabilities?.mcpCapabilities?.http === true &&
			binding.bridge !== undefined && !binding.bridge.empty;
		// A side turn never executes tools. Its legacy prompt guidance must say
		// so instead of advertising the main pi_task delegation mapping, and the
		// prompt planner must use the ephemeral history/continuation/retry text
		// that prohibits every tool call rather than only the pi_ guidance.
		const sessionGuidance = sessionAppend
			? undefined
			: ompToolGuidance(binding.initialize, routing?.nativeTools ?? "prefer", bridgeConfigured, "ephemeral");
		const planned = adaptPromptToCapabilities(
			buildPromptParts(dispatchContext, fresh, unseenStart, { contextWindow: model.contextWindow, maxTokens: model.maxTokens, policy: model.ompContextPolicy, sessionRouting: sessionAppend, sessionGuidance, promptKind: "ephemeral" }, plan.kind === "retry"),
			binding.initialize,
		);
		// OMP's occupancy signal describes the whole side context, not the delta
		// bytes this turn happened to send.
		const parts = { ...planned, estimatedContextTokens: estimateContextTokens(context) };

		let completeTurn: (() => void) | undefined;
		binding.writer = writer;
		binding.relay.beginTurn();
		binding.turnCompletion = new Promise<void>((resolve) => { completeTurn = resolve; });
		binding.ompInFlight = true;
		binding.ompTerminalStopReason = undefined;
		binding.instructionsFingerprint = instructionsFingerprint;
		binding.ompFallbackContextTokens = parts.estimatedContextTokens;
		try {
			if (options.signal?.aborted) throw abortError();
			const seedUsage = parts.seedSteps?.length
				? await this.promptShadowSeedSteps(binding, parts.seedSteps, options.signal)
				: undefined;
			const response = await binding.connection.prompt(
				{ sessionId: binding.session.sessionId, prompt: parts.prompt },
				options.signal,
			);
			const activeWriter = binding.writer ?? writer;
			if (binding.ompInvalidated) throw new AntigravityAcpError("protocol", "ACP session ownership was lost");
			binding.ompTerminalStopReason = response.stopReason;
			const usage = usageFromPrompt(response, binding.ompFallbackContextTokens);
			if (seedUsage) mergeUsage(usage, seedUsage);
			activeWriter.message.usage = usage;
			this.metrics.record(response, usage);
			const quota = response.stopReason === "cancelled"
				? undefined
				: quotaExhaustion(activeWriter.message.content.map(block => block.type === "text" ? block.text : "").join(""));
			if (quota) await this.ompThrowQuota(binding, quota);
			activeWriter.message.rawStopReason = response.stopReason;
			if (response.stopReason === "cancelled") throw abortError();
			// The ACP session now holds exactly this side context; the next turn
			// may reuse it while the leading main history is unchanged.
			binding.shadow = {
				kind: "clean",
				fingerprints: layout.fingerprints,
				absorbed: layout.mainLength,
				...current,
			};
			binding.ompInFlight = false;
			switch (response.stopReason) {
				case "refusal":
					throw new AcpFailure("refusal", "Antigravity refused the request");
				case "max_tokens":
				case "max_turn_requests":
					activeWriter.done("length");
					break;
				default:
					activeWriter.done("stop");
			}
		} catch (error) {
			binding.ompInFlight = false;
			binding.writer?.fail(error, isAbort(error));
			binding.shadow = {
				kind: "uncertain",
				reason: isAbort(error) || binding.abortRequested ? "cancelled" : "failed",
			};
			await this.invalidateBinding(binding).catch(() => undefined);
			throw error;
		} finally {
			completeTurn?.();
			binding.relay.endTurn();
			binding.turnCompletion = undefined;
			binding.ompFallbackContextTokens = undefined;
			binding.abortRequested = false;
			binding.writer = undefined;
			binding.ompSeeding = false;
			cancelPiTools(binding, "Side turns do not execute tools");
		}
	}

	private async promptShadowSeedSteps(
		binding: Binding,
		steps: NonNullable<PromptParts["seedSteps"]>,
		signal?: AbortSignal,
	): Promise<PromptUsageResult | undefined> {
		const savedWriter = binding.writer;
		binding.writer = undefined;
		binding.ompSeeding = true;
		let usage: PromptUsageResult | undefined;
		try {
			for (const step of steps) {
				binding.ompSeedText = "";
				if (signal?.aborted || binding.abortRequested) throw abortError();
				const response = await binding.connection.prompt({ sessionId: binding.session.sessionId, prompt: step }, signal);
				if (binding.ompInvalidated) throw new AntigravityAcpError("protocol", "ACP session ownership was lost");
				if (binding.abortRequested || response.stopReason === "cancelled" || signal?.aborted) throw abortError();
				const quota = quotaExhaustion(binding.ompSeedText ?? "");
				binding.ompSeedText = undefined;
				if (quota) await this.ompThrowQuota(binding, quota);
				if (response.stopReason !== "end_turn") throw new AntigravityAcpError("protocol", `ACP seed step stopped early with ${response.stopReason}`);
				const stepUsage = usageFromPrompt(response);
				usage = usage ? mergeUsage(usage, stepUsage) : stepUsage;
			}
			return usage;
		} finally {
			binding.ompSeeding = false;
			binding.ompSeedText = undefined;
			binding.writer = savedWriter;
		}
	}

	private async ompThrowQuota(binding: Binding, quota: { resetAt?: string }): Promise<never> {
		if (binding.permission || binding.pendingTools.size > 0) await this.invalidateBinding(binding);
		throw new AntigravityAcpError("quota", `Antigravity quota exceeded for ${binding.modelId}.${quota.resetAt ? ` Resets at ${quota.resetAt}.` : ""}`);
	}

	private async awaitContinuation(binding: Binding, signal?: AbortSignal): Promise<void> {
		const completion = binding.turnCompletion;
		if (!completion) return;
		if (!signal) {
			await completion;
			return;
		}
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const abort = () => {
			if (binding.turnCompletion !== completion || binding.abortRequested) return;
			abortTurn(binding);
			void binding.connection.cancel(binding.session.sessionId).catch(() => undefined);
			killTimer = setTimeout(() => {
				if (binding.turnCompletion === completion) void binding.connection.close();
			}, 1_500);
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		try {
			await completion;
		} finally {
			signal.removeEventListener("abort", abort);
			if (killTimer) clearTimeout(killTimer);
		}
	}

	private findContinuationKey(context: Context): string | undefined {
		for (const binding of this.resolvedBindings) {
			// A side channel never parks a tool result or a permission answer.
			if (binding.route.kind === "shadow") continue;
			if (binding.permission && findPermissionResult(context, binding.permission.id)) return binding.key;
			if (
				binding.pendingTools.size > 0 &&
				[...binding.pendingTools.values()].every((pending) =>
					findToolResult(context, pending.invocation.id, pending.invocation.name),
				)
			) {
				return binding.key;
			}
		}
		return undefined;
	}

	private async getBinding(
		key: string,
		route: SessionRoute,
		model: AntigravityModel,
		acpModelId: string,
		apiKey: string | undefined,
		writer: PiEventWriter,
		tools: Context["tools"],
		instructions: string,
		signal?: AbortSignal,
	): Promise<Binding> {
		this.assertActive();
		const existing = this.bindings.get(key);
		if (existing) {
            const value = await existing;
            (value.connection as AntigravityAcpConnection & OmpRoutedConnection).setOmpContextWindow?.(value.session.sessionId, model.contextWindow);
            if (!value.ompInvalidated) return value;
            await value.ompDropPromise;
            if (this.bindings.get(key) === existing) this.bindings.delete(key);
            return this.getBinding(key, route, model, acpModelId, apiKey, writer, tools, instructions, signal);
          }
		const created = this.createBinding(key, route, model, acpModelId, apiKey, writer, tools ?? [], instructions, signal).catch((error) => {
			if (this.bindings.get(key) === created) this.bindings.delete(key);
			throw error;
		});
		this.bindings.set(key, created);
		return created;
	}

	private async createBinding(
		key: string,
		route: SessionRoute,
		model: AntigravityModel,
		acpModelId: string,
		apiKey: string | undefined,
		writer: PiEventWriter,
		tools: NonNullable<Context["tools"]>,
		instructions: string,
		signal?: AbortSignal,
	): Promise<Binding> {
		const cwd = process.cwd();
		let binding: Binding | undefined;
		let bridge: PiMcpBridge | undefined;
		let relayBridge: PiMcpBridge | undefined;
		const piSessionId = key.startsWith("sid:") ? key.slice(4) : undefined;
		let session: AcpNewSessionResponse | undefined;
		let restored = false;
		const epoch = this.bindingEpoch;
		let leaseLost = false;
		let releaseLease: (() => Promise<void>) | undefined;
		const connection = this.createConnection({
			cwd,
			handlers: {
				onUpdate: (notification) => this.consumeUpdate(binding, notification),
				onPermission: (request) => this.requestPermission(binding, request),
            },
          });
          try {
            if (key.startsWith('sid:') && typeof this.sessionStore?.acquireSessionLease === 'function') {
              const releaseOwnedLease = await this.sessionStore.acquireSessionLease(key.slice(4), () => { leaseLost = true; if (binding) binding.ompInvalidated = true; void connection.close().catch(() => {}); });
              let releaseDone: Promise<void> | undefined;
              const releaseOwned = async () => {
                if (releaseDone) return releaseDone;
                releaseDone = releaseOwnedLease().catch(() => {});
                return releaseDone;
              };
              releaseLease = async (wait = false) => {
                if (connection.process.alive) {
                  if (wait) {
                    await Promise.race([
                      connection.process.exited,
                      new Promise(resolve => setTimeout(resolve, 2000)),
                    ]).catch(() => {});
                  } else {
                    void connection.process.exited.then(releaseOwned).catch(() => {});
                    return;
                  }
                }
                await releaseOwned();
              };
              this.assertEpoch(epoch);
            }
			const initialize = await connection.initialize();
			this.assertEpoch(epoch);
			// initialize has completed and the MCP capability is known, so the
			// session RPCs below can carry the complete instruction through the
			// advertised system-append channel instead of the first prompt. A side
			// binding routes the ephemeral tool guidance, never the main one.
			const routed = connection as AntigravityAcpConnection & OmpRoutedConnection;
			routed.setOmpSystemInstructions?.(instructions);
			routed.setOmpSessionKind?.(route.kind === "shadow" ? "ephemeral" : "main");
			await authenticateForCredential(connection, initialize, apiKey, signal);
			this.assertEpoch(epoch);
			const omittedTools = initialize.agentCapabilities?.mcpCapabilities?.http === true
				? planToolProjection(tools)
				: tools.filter((tool) => tool.name !== PERMISSION_TOOL_NAME).map((tool) => ({ name: tool.name, reason: "Agent did not advertise MCP over HTTP" }));
			const relayConfig = this.ompRelayConfig();
			const relay = new ToolRelay(relayConfig);
			const relayCollision = relayConfig.enabled ? tools.find(tool => projectedMcpName(tool.name) === TOOL_RELAY_CONTROL_NAME) : undefined;
			if (relayCollision) throw new AntigravityAcpError("invalid_input", "Tool " + relayCollision.name + " collides with the relay control tool " + TOOL_RELAY_CONTROL_NAME + "; rename it or disable OMP_ACP_TOOL_RELAY_MS");
			let mcpServer;
			let relayServer;
			if (tools.length > 0 && initialize.agentCapabilities?.mcpCapabilities?.http === true) {
				bridge = new PiMcpBridge({
					tools,
					onCall: (invocation) => relay.call(invocation, () => this.requestPiTool(binding, invocation)),
				});
				mcpServer = await bridge.start();
				if (relayConfig.enabled) {
					relayBridge = new PiMcpBridge({
						tools: [relayControlTool],
						onCall: (invocation) => {
							const callId = invocation.arguments.call_id;
							return typeof callId === "string" && callId
								? relay.await(callId)
								: Promise.resolve({ content: [{ type: "text", text: "call_id must be a non-empty string" }], isError: true });
						},
					});
					relayServer = await relayBridge.start();
					if (relayServer) relayServer.name = "pi-relay";
				}
			}
			const mcpServers = [];
			if (mcpServer) mcpServers.push(mcpServer);
			if (relayServer) mcpServers.push(relayServer);
			let saved = piSessionId ? await this.sessionStore?.get(piSessionId) : undefined;
            if (saved && (saved.ompCheckpointVersion !== 1 || saved.ompInFlight !== false)) {
              await connection.retireForReplacement?.(key, saved.acpSessionId);
              await this.ompRemoveSaved(saved.piSessionId, saved.acpSessionId);
              saved = undefined;
            }
			if (saved?.cwd === cwd) {
				if (initialize.agentCapabilities?.sessionCapabilities?.resume) {
					try {
						const resumed = await connection.resumeSession(saved.acpSessionId, cwd, mcpServers, signal);
						session = { sessionId: saved.acpSessionId, ...resumed };
						restored = true;
					} catch {
						// Some Antigravity builds advertise the draft method before implementing it.
					}
				}
				if (!session && initialize.agentCapabilities?.loadSession === true) {
					try {
						const loaded = await connection.loadSession(saved.acpSessionId, cwd, mcpServers, signal);
						session = { sessionId: saved.acpSessionId, ...loaded };
						restored = true;
					} catch {
						await this.ompRemoveSaved(saved.piSessionId, saved.acpSessionId);
					}
				}
			}
			if (!session && saved) { await connection.retireForReplacement?.(key, saved.acpSessionId); await this.ompRemoveSaved(saved.piSessionId, saved.acpSessionId); }
			session ??= await connection.newSession(cwd, signal, mcpServers);
			this.assertEpoch(epoch);
			const mode = this.permissionMode;
			if (!supportsMode(session, mode)) {
				if (restored && saved) { await connection.retireForReplacement?.(key, saved.acpSessionId); await this.ompRemoveSaved(saved.piSessionId, saved.acpSessionId); } else await connection.discardSession?.(session.sessionId);
				throw new AntigravityAcpError("protocol", `Antigravity ${restored ? "restored" : "new"} session did not advertise permission mode '${mode}'; refusing to prompt`);
			}
			if (sessionModes(session)?.currentModeId !== mode) await connection.setMode(session.sessionId, mode, signal);
			if (sessionModes(connection.getSessionState(session.sessionId))?.currentModeId !== mode) {
				throw new AntigravityAcpError("protocol", "Antigravity did not confirm the requested permission mode");
			}
			const currentModel = sessionModels(session)?.currentModelId;
			if (currentModel !== acpModelId) await connection.setModel(session.sessionId, acpModelId, signal);
			this.assertEpoch(epoch);
			if (mode !== this.permissionMode) throw new AntigravityAcpError("protocol", "Permission mode changed during session setup; retry the turn");
			const createdBinding: Binding = {
            ompInFlight: false, ompInvalidated: false,
            ompReleaseLease: releaseLease,
            ompExpectedAssistantHasOutput: restored && (saved?.ompExpectedAssistantHasOutput === true ||
              (saved?.ompExpectedAssistantHasOutput === undefined && Boolean(saved?.expectedAssistantFingerprint))),
            relay, relayBridge, relayFingerprint: relayConfig.fingerprint,
            pendingConversationFingerprint: this.ompMessagesFingerprint([]),
				key,
				route,
				cwd,
				connection,
				initialize,
				session,
				mode,
				instructionsFingerprint: restored ? saved?.ompInstructionsFingerprint : undefined,
				needsReconstruction: false,
				modelId: acpModelId,
				messageCount: restored && saved ? saved.messageCount : 0,
				ompCancelledCheckpoint: restored && saved?.ompCancelledCheckpoint === true,
				ompCancelledHadOutput: restored && saved?.ompCancelledHadOutput === true,
				ompExpectedAssistantNormalized: restored ? saved?.ompExpectedAssistantNormalized : undefined,
				ompConversationFingerprint: restored ? saved?.ompConversationFingerprint : undefined,
				historyFingerprint: restored && saved ? saved.historyFingerprint : this.ompMessagesFingerprint([]),
				expectedAssistantFingerprint: restored ? saved?.expectedAssistantFingerprint : undefined,
				pendingContextCount: 0,
				pendingContextFingerprint: this.ompMessagesFingerprint([]),
				writer,
				permission: undefined,
				pendingTools: new Map(),
				toolBatchTimer: undefined,
				bridge,
				toolFingerprint: this.ompToolsFingerprint(tools),
				omittedTools,
				turnCompletion: undefined,
				abortRequested: false,
				piSessionId,
				restored,
			};
			binding = createdBinding;
            (binding.connection as AntigravityAcpConnection & OmpRoutedConnection).setOmpContextWindow?.(binding.session.sessionId, model.contextWindow);
            if (leaseLost) throw new AntigravityAcpError('protocol', 'ACP session ownership was lost during initialization');
			await this.persistBinding(createdBinding);
		this.assertEpoch(epoch);
			this.resolvedBindings.add(createdBinding);
			void connection.process.exited.then(() => {
            const completion = createdBinding.turnCompletion;
            const retiring = createdBinding.ompDropPromise;
            void Promise.resolve(retiring ?? completion).then(() => createdBinding.ompReleaseLease?.()).catch(() => {});
				cancelPermission(createdBinding);
				cancelPiTools(createdBinding, "Antigravity process exited before Pi returned the tool result");
				this.resolvedBindings.delete(createdBinding);
				void bridge?.close().catch(() => undefined);
				void relayBridge?.close().catch(() => undefined);
				const current = this.bindings.get(key);
				if (current) void current.then((value) => {
					if (value === createdBinding && this.bindings.get(key) === current && !createdBinding.ompInvalidated) this.bindings.delete(key);
				}).catch(() => undefined);
			}).catch(() => undefined);
			return createdBinding;
		} catch (error) {
			if (session?.sessionId && !restored) {
              if (piSessionId) await this.ompRemoveSaved(piSessionId, session.sessionId).catch(() => {});
              if (route.kind === "shadow") await closeAcpSession(connection, session.sessionId);
              try { await connection.discardSession?.(session.sessionId); } catch {}
            }
            await Promise.allSettled([connection.close(), bridge?.close() ?? Promise.resolve(), relayBridge?.close() ?? Promise.resolve()]);
            await releaseLease?.();
			throw error;
		}
	}

	private async persistBinding(binding: Binding): Promise<void> {
		// Shadow checkpoints are transport state only. They never enter the OMP
		// session store, never advance the main checkpoint and never touch the
		// main prompt path; only a main binding may write this record.
		if (binding.route.kind === "shadow") return;
		if (!binding.piSessionId || binding.ompInvalidated) return;
		if (binding.needsReconstruction) { await binding.connection.retireForReplacement?.(binding.key, binding.session.sessionId); await this.ompRemoveSaved(binding.piSessionId, binding.session.sessionId); return; }
		await this.sessionStore?.save({
			piSessionId: binding.piSessionId,
			acpSessionId: binding.session.sessionId,
			acpModelId: binding.modelId,
 ompCheckpointVersion: 1, ompInFlight: binding.ompInFlight === true, ompExpectedAssistantHasOutput: binding.ompExpectedAssistantHasOutput === true,
			ompCancelledCheckpoint: binding.ompCancelledCheckpoint === true,
			ompCancelledHadOutput: binding.ompCancelledHadOutput === true,
			...(binding.ompExpectedAssistantNormalized ? { ompExpectedAssistantNormalized: binding.ompExpectedAssistantNormalized } : {}),
			...(binding.instructionsFingerprint ? { ompInstructionsFingerprint: binding.instructionsFingerprint } : {}),
			...(binding.ompConversationFingerprint ? { ompConversationFingerprint: binding.ompConversationFingerprint } : {}),
			cwd: binding.cwd,
			messageCount: binding.messageCount,
			historyFingerprint: binding.historyFingerprint,
			...(binding.expectedAssistantFingerprint
				? { expectedAssistantFingerprint: binding.expectedAssistantFingerprint }
				: {}),
			lastActive: Date.now(),
		});
	}

	private requestPiTool(
		binding: Binding | undefined,
		invocation: PiToolInvocation,
	): Promise<CallToolResult> {
		// BTW side turns declare the catalog only to keep the prompt cache warm;
		// the prompt itself says tool calls are discarded without execution.
		if (binding?.route.kind === "shadow") {
			return Promise.resolve({
				content: [{ type: "text", text: "Tools are not available in this ephemeral side turn; the call was discarded." }],
				isError: true,
			});
		}
		if (!binding?.writer || binding.writer.finished || binding.permission || binding.abortRequested) {
			return Promise.resolve({
				content: [{ type: "text", text: "Pi cannot accept this tool call in the current turn" }],
				isError: true,
			});
		}
		return new Promise<CallToolResult>((resolve) => {
			let release: (() => void) | undefined;
			try {
				release = binding.connection.holdPromptWatchdog(binding.session.sessionId);
				const held = release;
				binding.pendingTools.set(invocation.id, { invocation, resolve: (result) => { held(); resolve(result); } });
				binding.writer?.toolCall(invocation.id, invocation.name, invocation.arguments);
				if (binding.toolBatchTimer) clearTimeout(binding.toolBatchTimer);
				binding.toolBatchTimer = setTimeout(() => {
					binding.toolBatchTimer = undefined;
					binding.writer?.done("toolUse");
				}, TOOL_BATCH_MS);
				binding.toolBatchTimer.unref();
			} catch {
				binding.pendingTools.delete(invocation.id);
				release?.();
				resolve({ content: [{ type: "text", text: "Pi could not accept the tool call" }], isError: true });
			}
		});
	}

	private requestPermission(
		binding: Binding | undefined,
		request: RequestPermissionRequest,
	): Promise<RequestPermissionResponse> {
		// A side turn has no OMP tool loop to answer a permission prompt, so it
		// must cancel rather than park the prompt for the permission timeout.
		if (!binding || binding.route.kind === "shadow" || !binding.writer || binding.writer.finished || binding.permission || binding.abortRequested || request.sessionId !== binding.session.sessionId) {
			return Promise.resolve({ outcome: { outcome: "cancelled" } });
		}
		const id = crypto.randomUUID();
		return new Promise<RequestPermissionResponse>((resolve) => {
			const timer = setTimeout(() => {
				if (binding.permission?.id !== id) return;
				binding.permission = undefined;
				resolve({ outcome: { outcome: "cancelled" } });
			}, PERMISSION_TIMEOUT_MS);
			timer.unref();
			binding.permission = { id, request, resolve, timer };
			try {
				binding.writer?.toolCall(id, PERMISSION_TOOL_NAME, { requestId: id });
				binding.writer?.done("toolUse");
			} catch {
				clearTimeout(timer);
				if (binding.permission?.id === id) binding.permission = undefined;
				resolve({ outcome: { outcome: "cancelled" } });
			}
		});
	}

	private consumeUpdate(binding: Binding | undefined, notification: SessionNotification): void {
		if (!binding || notification.sessionId !== binding.session.sessionId) return;
		if (notification.update.sessionUpdate === "compaction_update" || notification.update.sessionUpdate === "compaction_summary_chunk") {
			if (binding.permission || binding.pendingTools.size > 0) {
				binding.needsReconstruction = true;
				binding.ompCompactionInvalidated = true;
			}
			return;
		}
		if (binding.ompSeeding && notification.update.sessionUpdate === "agent_message_chunk" && notification.update.content.type === "text") {
			binding.ompSeedText = (binding.ompSeedText ?? "") + notification.update.content.text;
		}
		if ((notification.update.sessionUpdate === "config_option_update" || notification.update.sessionUpdate === "current_mode_update") &&
			this.confirmedMode(binding) !== this.permissionMode) {
			binding.writer?.fail(new AntigravityAcpError("protocol", "Antigravity changed the permission mode unexpectedly; session closed"), false);
			void this.invalidateBinding(binding).catch(() => undefined);
			return;
		}
		if (!binding.writer) return;
		for (const activity of mapSessionUpdate(notification)) {
			if (activity.type === "text") binding.writer.text(activity.delta);
			else if (activity.type === "thought") binding.writer.thinking(activity.delta);
			// ACP tool and plan status are UI activity, not model reasoning.
		}
	}

	private async ompRemoveSaved(piSessionId: string, acpSessionId: string): Promise<void> {
          if (typeof this.sessionStore?.removeIfMatches === 'function') await this.sessionStore.removeIfMatches(piSessionId, acpSessionId);
          else await this.sessionStore?.remove(piSessionId);
        }
        private async dropBinding(key: string, binding: Binding, removeSaved = false): Promise<void> {
          if (removeSaved) binding.ompInvalidated = true;
          if (binding.ompDropPromise) {
            await binding.ompDropPromise;
            if (!binding.piSessionId) {
              await this.discardBindingSession(binding);
            } else if (removeSaved) {
              await binding.connection.retireForReplacement?.(key, binding.session.sessionId);
              await this.ompRemoveSaved(binding.piSessionId, binding.session.sessionId);
            }
            return;
          }
          const dropping = (async () => {
            const current = this.bindings.get(key);
            this.resolvedBindings.delete(binding);
            cancelPermission(binding);
            cancelPiTools(binding, 'Antigravity session closed before Pi returned the tool result');
            try {
              if (!binding.piSessionId) {
                await this.discardBindingSession(binding);
              } else if (removeSaved) {
                await binding.connection.retireForReplacement?.(key, binding.session.sessionId);
                await this.ompRemoveSaved(binding.piSessionId, binding.session.sessionId);
              }
            } finally {
              await Promise.allSettled([binding.connection.close(), binding.bridge?.close() ?? Promise.resolve(), binding.relayBridge?.close() ?? Promise.resolve()]);
              await binding.ompReleaseLease?.(true);
              if (current && (await current) === binding && this.bindings.get(key) === current) this.bindings.delete(key);
            }
          })();
          binding.ompDropPromise = dropping;
          await dropping;
        }
        // A shadow owns its ACP session but no OMP store row. Free it through
        // `session/close` when the agent advertises it, then always discard the
        // recovery copy and close the connection/lease in the caller.
        private async discardBindingSession(binding: Binding): Promise<void> {
          const sessionId = binding.session.sessionId;
          if (binding.route.kind === "shadow") await closeAcpSession(binding.connection, sessionId);
          await binding.connection.discardSession?.(sessionId);
        }
        private confirmedMode(binding: Binding): string | undefined {
		return sessionModes(binding.connection.getSessionState(binding.session.sessionId))?.currentModeId;
	}

	private async noteContinuationInstructions(binding: Binding, context: Context): Promise<void> {
		if (binding.instructionsFingerprint !== instructionFingerprint(context)) {
			// ACP has no system-update RPC. Finish this immutable prompt, then rebuild;
			// do not persist a fingerprint claiming the new instructions reached ACP.
			binding.needsReconstruction = true;
			await binding.connection.retireForReplacement?.(binding.key, binding.session.sessionId);
			if (binding.piSessionId) await this.ompRemoveSaved(binding.piSessionId, binding.session.sessionId);
		}
	}

	private async invalidateBinding(binding: Binding): Promise<void> {
		if (binding.turnCompletion) abortTurn(binding);
		await this.dropBinding(binding.key, binding, true);
	}

	private createConnection(options: AntigravityConnectionOptions): AntigravityAcpConnection {
		this.assertActive();
		const connection = this.connectionFactory(options);
		this.activeConnections.add(connection);
		void connection.process.exited.then(() => this.activeConnections.delete(connection)).catch(() => undefined);
		return connection;
	}

	private assertEpoch(epoch: number): void {
		this.assertActive();
		if (epoch !== this.bindingEpoch) throw new AntigravityAcpError("process_exit", "Antigravity session was closed during setup");
	}

	private assertActive(): void {
		if (this.disposed) throw new AntigravityAcpError("process_exit", "Antigravity ACP runtime is closed");
	}
}

export async function authenticateForCredential(
	connection: AntigravityAcpConnection,
	initialize: InitializeResponse,
	apiKey: string | undefined,
	signal?: AbortSignal,
): Promise<void> {
	const key = usableApiKey(apiKey);
	if (!key) return;
	const method = initialize.authMethods?.find((candidate) => {
		const meta = candidate._meta as Record<string, unknown> | null | undefined;
		return "api-key" in (meta ?? {}) || /api key/iu.test(candidate.name);
	});
	if (!method) throw new AntigravityAcpError("auth", "Antigravity ACP did not advertise API-key authentication");
	await connection.authenticate({ methodId: method.id, _meta: { "api-key": key } }, signal);
}

function adaptPromptToCapabilities(parts: PromptParts, initialize: InitializeResponse): PromptParts {
	const capabilities = initialize.agentCapabilities?.promptCapabilities;
	const output: ContentBlock[] = [];
	for (const block of parts.prompt) {
		if (block.type === "image" && capabilities?.image !== true) {
			throw new AntigravityAcpError("invalid_input", "This Antigravity ACP runtime did not advertise image input");
		}
		if (block.type === "resource" && capabilities?.embeddedContext !== true) {
			const resource = block.resource;
			if ("text" in resource) output.push({ type: "text", text: resource.text });
			continue;
		}
		output.push(block);
	}
	return { ...parts, prompt: output, ...(parts.seedSteps ? { seedSteps: parts.seedSteps.map(step => adaptPromptToCapabilities({ prompt: step, messageCount: parts.messageCount, estimatedContextTokens: parts.estimatedContextTokens }, initialize).prompt) } : {}) };
}

function hasUsableLocalAuth(health: AntigravityAuthHealth): boolean {
	return health.status === "api-key-env" || health.status === "oauth-refreshable";
}

function supportsMode(session: SessionState, mode: PermissionMode): boolean {
	return sessionModes(session)?.availableModes.some((candidate) => candidate.id === mode) === true;
}

function permissionView(permission: PendingPermission): PermissionView {
	const call = permission.request.toolCall;
	const details = {
		kind: call.kind,
		locations: call.locations,
		content: call.content,
		rawInput: call.rawInput,
	};
	const visibleDetails = JSON.stringify(details, null, 2).slice(0, 8_000);
	return {
		id: permission.id,
		title: `${call.title ?? "Antigravity requests permission"}\n\n${visibleDetails}`,
		options: permission.request.options.map((option) => ({
			id: option.optionId,
			label: option.name,
			kind: option.kind,
		})),
	};
}

function findPermissionResult(context: Context, requestId: string): PermissionToolResult | undefined {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (
			message?.role !== "toolResult" ||
			message.toolName !== PERMISSION_TOOL_NAME ||
			message.toolCallId !== requestId
		) {
			continue;
		}
		const details = message.details as Partial<PermissionToolResult> | undefined;
		if (
			details?.kind === PERMISSION_RESULT_KIND &&
			details.requestId === requestId &&
			typeof details.cancelled === "boolean"
		) {
			return details as PermissionToolResult;
		}
		// A missing/disabled tool or malformed output is an immediate denial,
		// never an implicit approval and never a hung ACP request.
		return {
			kind: PERMISSION_RESULT_KIND,
			requestId,
			cancelled: true,
		};
	}
	return undefined;
}

function messagesFingerprint(messages: Context["messages"], systemMemo?: any): string {
	const fingerprints = messages.map(message => messageFingerprint(message, systemMemo));
	return createHash("sha256").update(fingerprints.join("\n")).digest("hex");
}

function messageFingerprint(message: Context["messages"][number], systemMemo?: any): string {
	let value: unknown;
	if (message.role === "user") {
		value = { role: message.role, content: message.content };
	} else if (message.role === "assistant") {
		value = {
			role: message.role,
			provider: message.provider,
			model: message.model,
			content: message.content,
		};
	} else if (message.role === "system") {
		value = {
			role: message.role,
			content: message.content,
			sections: message.sections,
			toolsAdded: message.toolsAdded,
			toolsRemoved: message.toolsRemoved,
		};
	} else {
		value = {
			role: message.role,
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			content: message.content,
			isError: message.isError,
		};
	}
	const compute = () => createHash("sha256").update(canonicalJson(value)).digest("hex"); return message.role === "system" && systemMemo ? systemMemo(value, compute) : ompMessageFingerprintMemo(message, value, compute);
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

// `session/close` frees a side session server-side when the agent advertises
// `sessionCapabilities.close`. It is optional: process close remains the
// fallback and must never depend on this RPC succeeding.
async function closeAcpSession(connection: AntigravityAcpConnection, sessionId: string): Promise<void> {
	try { await connection.closeSession?.(sessionId); } catch { /* process close still frees it */ }
}

function shadowBindingKey(parentRoutingId: string): string {
	return `shadow:${parentRoutingId}`;
}

// The side context is main history, an ephemeral `developer` instruction and
// the latest question. Only role/content participate, so provider metadata and
// timestamps never force a false divergence.
interface SideMessage {
	role: string;
	content: unknown;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
}

interface SideLayout {
	fingerprints: readonly string[];
	/** Leading main-history messages, before the ephemeral scaffold. */
	mainLength: number;
	scaffold: readonly string[];
	question: string;
	trailingQuestion: boolean;
}

function shadowMessageFingerprint(message: SideMessage): string {
	const value = message.role === "toolResult"
		? { role: message.role, toolCallId: message.toolCallId, toolName: message.toolName, content: message.content, isError: message.isError }
		: { role: message.role, content: message.content };
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sideLayout(messages: Context["messages"]): SideLayout {
	const side = messages as unknown as readonly SideMessage[];
	const fingerprints = side.map(shadowMessageFingerprint);
	let questionIndex = side.length - 1;
	while (questionIndex >= 0 && side[questionIndex]!.role !== "user") questionIndex--;
	if (questionIndex < 0) throw new Error("No user message to send to Antigravity ACP");
	let scaffoldStart = questionIndex;
	while (scaffoldStart > 0 && side[scaffoldStart - 1]!.role === "developer") scaffoldStart--;
	return {
		fingerprints,
		mainLength: scaffoldStart,
		scaffold: fingerprints.slice(scaffoldStart, questionIndex),
		question: fingerprints[questionIndex]!,
		trailingQuestion: questionIndex === side.length - 1,
	};
}

type ShadowPlan =
	| { kind: "seed" }
	| { kind: "delta"; unseenStart: number }
	| { kind: "retry" }
	| { kind: "rebuild"; reason: ShadowRebuildReason };

function commonPrefixLength(left: readonly string[], right: readonly string[]): number {
	const limit = Math.min(left.length, right.length);
	let index = 0;
	while (index < limit && left[index] === right[index]) index++;
	return index;
}

function sameFingerprints(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && commonPrefixLength(left, right) === left.length;
}

// Longest-common-prefix dispatch. Growth sends the unseen suffix, a replaced
// last question is a new request, an identical replacement is the only retry,
// and any deeper divergence or uncertain delivery rebuilds the shadow.
function planShadowDispatch(
	checkpoint: ShadowCheckpoint | undefined,
	layout: SideLayout,
	current: { modelId: string; mode: PermissionMode; instructions: string },
): ShadowPlan {
	if (!checkpoint) return { kind: "seed" };
	if (checkpoint.kind === "uncertain") return { kind: "rebuild", reason: checkpoint.reason };
	if (checkpoint.modelId !== current.modelId || checkpoint.mode !== current.mode) {
		return { kind: "rebuild", reason: "model-or-mode-change" };
	}
	if (checkpoint.instructions !== current.instructions) return { kind: "rebuild", reason: "instructions" };
	if (!layout.trailingQuestion) return { kind: "rebuild", reason: "rewind" };
	const savedMain = checkpoint.fingerprints.slice(0, checkpoint.absorbed);
	const savedScaffold = checkpoint.fingerprints.slice(checkpoint.absorbed, checkpoint.fingerprints.length - 1);
	const newMain = layout.fingerprints.slice(0, layout.mainLength);
	if (commonPrefixLength(savedMain, newMain) !== savedMain.length) return { kind: "rebuild", reason: "rewind" };
	// A changed ephemeral instruction cannot be updated mid-conversation.
	if (!sameFingerprints(savedScaffold, layout.scaffold)) return { kind: "rebuild", reason: "instructions" };
	if (layout.mainLength === savedMain.length && checkpoint.fingerprints[checkpoint.fingerprints.length - 1] === layout.question) {
		return { kind: "retry" };
	}
	return { kind: "delta", unseenStart: savedMain.length };
}

function mergeUsage(target: PromptUsageResult, add: PromptUsageResult): PromptUsageResult {
	target.input += add.input;
	target.output += add.output;
	target.cacheRead += add.cacheRead;
	target.cacheWrite += add.cacheWrite;
	target.totalTokens += add.totalTokens;
	target.cost.input += add.cost.input;
	target.cost.output += add.cost.output;
	target.cost.cacheRead += add.cost.cacheRead;
	target.cost.cacheWrite += add.cost.cacheWrite;
	target.cost.total += add.cost.total;
	if (add.reasoning !== undefined) target.reasoning = (target.reasoning ?? 0) + add.reasoning;
	return target;
}

function findToolResult(
	context: Context,
	toolCallId: string,
	toolName: string,
): ToolResultMessage | undefined {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (
			message?.role === "toolResult" &&
			message.toolCallId === toolCallId &&
			message.toolName === toolName
		) {
			return message;
		}
	}
	return undefined;
}

function toMcpToolResult(message: ToolResultMessage): CallToolResult {
	return {
		content: message.content.map((block) =>
			block.type === "text"
				? { type: "text" as const, text: block.text }
				: { type: "image" as const, data: block.data, mimeType: block.mimeType },
		),
		isError: message.isError,
	};
}

function cancelPermission(binding: Binding): void {
	if (!binding.permission) return;
	clearTimeout(binding.permission.timer);
	binding.permission.resolve({ outcome: { outcome: "cancelled" } });
	binding.permission = undefined;
}

function instructionFingerprint(context: Context): string {
	return createHash("sha256").update(stableSystemInstructions(context)).digest("hex");
}

function abortTurn(binding: Binding): void {
	binding.abortRequested = true;
	cancelPermission(binding);
	cancelPiTools(binding, "Pi turn was aborted before returning the tool result");
}

function cancelPiTools(binding: Binding, reason: string): void {
	binding.relay.cancelAll(reason);
	if (binding.toolBatchTimer) clearTimeout(binding.toolBatchTimer);
	binding.toolBatchTimer = undefined;
	for (const pending of binding.pendingTools.values()) {
		pending.resolve({ content: [{ type: "text", text: reason }], isError: true });
	}
	binding.pendingTools.clear();
}

async function raceAuthentication<T>(
	step: Promise<T>,
	authentication: Promise<void>,
): Promise<{ authenticated: true } | { authenticated: false; value: T }> {
	return Promise.race([
		step.then((value) => ({ authenticated: false as const, value })),
		authentication.then(() => ({ authenticated: true as const })),
	]);
}

function isAbort(error: unknown): boolean {
	return error instanceof AntigravityAcpError
		? error.code === "aborted"
		: error instanceof DOMException && error.name === "AbortError";
}
