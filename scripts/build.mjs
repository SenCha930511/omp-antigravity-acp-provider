import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstream = path.join(root, "extension/vendor/pi-antigravity-acp-provider");
const assets = path.join(root, "extension/assets");
await fs.mkdir(path.join(assets, "src/acp"), { recursive: true });
await fs.copyFile(path.join(upstream, "src/acp/supervisor.mjs"), path.join(assets, "src/acp/supervisor.mjs"));
await fs.copyFile(path.join(upstream, "runtime-manifest.json"), path.join(assets, "runtime-manifest.json"));
const exports = [
  ["createAntigravityProvider", "provider.ts"],
  ["AntigravityRuntime, PERMISSION_TOOL_NAME, PERMISSION_RESULT_KIND", "runtime.ts"],
  ["loadConfig, savePermissionMode", "config.ts"],
  ["inspectAntigravityAuth, hasAntigravityAuth, clearAntigravityCredentials, resolveAntigravityAcpDirectory", "acp/antigravity.ts"],
  ["describeCredentialStorage", "acp/credential-storage.ts"],
  ["FALLBACK_MODELS, projectModels", "models.ts"],
  ["AcpSessionStore", "acp/session-store.ts"],
  ["ensureAntigravityAcpReady", "acp/setup.ts"],
  ["planToolProjection", "mcp/bridge.ts"],
  ["PiEventWriter", "stream/pi-events.ts"],
];
const result = await build({
  stdin: {
    contents: [
      ...exports.map(([names, file]) => `export { ${names} } from ${JSON.stringify(file === "acp/session-store.ts" ? path.join(root, "extension/session-store.ts") : path.join(upstream, "src", file))};`),
      `export { TierConnection } from ${JSON.stringify(path.join(root, "extension/tier-connection.ts"))};`,
      `export { SessionCleanup } from ${JSON.stringify(path.join(root, "extension/session-cleanup.ts"))};`,
      'export { Type } from "typebox";',
    ].join("\n"),
    resolveDir: root,
    sourcefile: "omp-adapter-entry.ts",
    loader: "ts",
  },
  bundle: true,
  metafile: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Bundled CJS dependencies need require in ESM. Asset locations are resolved
  // on the consuming machine rather than embedded from the build machine.
  banner: { js: [
    'import { createRequire as __ompCreateRequire } from "node:module";',
    'const require = __ompCreateRequire(import.meta.url);',
    'const __ompAssetURL = (specifier) => new URL(specifier.replace("pi-antigravity-acp-provider/", "./assets/"), import.meta.url).href;',
  ].join("\n") },
  external: ["@aws-sdk/client-s3"],
  plugins: [{
    name: "portable-upstream-assets",
    setup(builder) {
      builder.onResolve({ filter: /^\.\/stream\/context\.js$/ }, ({ importer }) => {
        if (importer === path.join(upstream, "src/runtime.ts")) return { path: path.join(root, "extension/context-transfer.ts") };
      });
      builder.onResolve({ filter: /^\.\/stream\/usage\.js$/ }, ({ importer }) => {
        if (importer === path.join(upstream, "src/runtime.ts")) return { path: path.join(root, "extension/usage.ts") };
      });
      builder.onResolve({ filter: /^\.\/acp\/usage-quota\.js$/ }, ({ importer }) => {
        if (importer === path.join(upstream, "src/runtime.ts")) return { path: path.join(root, "extension/usage-accounting.ts") };
      });
      builder.onResolve({ filter: /^\.\/acp\/session-store\.js$/ }, ({ importer }) => {
        if (importer === path.join(upstream, "src/runtime.ts")) return { path: path.join(root, "extension/session-store.ts") };
      });
      builder.onLoad({ filter: /\/src\/runtime\.ts$/ }, async ({ path: file }) => {
        if (file !== path.join(upstream, "src/runtime.ts")) return;
        const patches = [
          {
            name: "quota parser imports",
            anchor: 'import { abortError, AntigravityAcpError, errorMessage } from "./acp/errors.js";',
            replacement: 'import { abortError, AntigravityAcpError, errorMessage } from "./acp/errors.js";\nimport { parseUsageQuota, quotaExhaustion, type AntigravityQuotaSnapshot } from "./acp/usage-quota.js";\ntype OmpQuotaRequest = { epoch: number; owner: string; controller: AbortController; subscribers: number; snapshot: Promise<AntigravityQuotaSnapshot> };',
          },
          {
            name: "quota state",
            anchor: "\tprivate permissionMode: PermissionMode;",
            replacement: "\tprivate permissionMode: PermissionMode;\n\tprivate quotaCache: AntigravityQuotaSnapshot | undefined;\n\tprivate quotaCacheOwner: string | undefined;\n\tprivate readonly quotaInFlights = new Set<OmpQuotaRequest>();",
          },
          {
            name: "ephemeral quota queries",
            anchor: "\tasync loginGoogle(",
            replacement: [
              "\tasync quota(apiKey: string | undefined, signal?: AbortSignal): Promise<AntigravityQuotaSnapshot> {",
              "\t\tthis.assertActive();",
              "\t\tif (signal?.aborted) throw abortError();",
              "\t\tconst owner = apiKey === undefined ? \"managed\" : `key:${createHash(\"sha256\").update(apiKey).digest(\"hex\")}`;",
              "\t\tif (this.quotaCacheOwner === owner && this.quotaCache && Date.now() - this.quotaCache.at < 60_000) return this.quotaCache;",
              "\t\tconst epoch = this.bindingEpoch;",
              "\t\tlet request = [...this.quotaInFlights].find(candidate => candidate.epoch === epoch && candidate.owner === owner && !candidate.controller.signal.aborted);",
              "\t\tif (!request) {",
              "\t\t\tconst controller = new AbortController();",
              "\t\t\tlet created!: OmpQuotaRequest;",
              "\t\t\tconst snapshot = this.ompFetchQuota(apiKey, controller.signal).then(value => {",
              "\t\t\t\tif (this.bindingEpoch === epoch && !this.disposed && !controller.signal.aborted) {",
              "\t\t\t\t\tthis.quotaCache = value;",
              "\t\t\t\t\tthis.quotaCacheOwner = owner;",
              "\t\t\t\t}",
              "\t\t\t\treturn value;",
              "\t\t\t}).finally(() => { this.quotaInFlights.delete(created); });",
              "\t\t\tcreated = { epoch, owner, controller, subscribers: 0, snapshot };",
              "\t\t\tthis.quotaInFlights.add(created);",
              "\t\t\trequest = created;",
              "\t\t}",
              "\t\tconst active = request;",
              "\t\tactive.subscribers++;",
              "\t\tconst { promise, resolve, reject } = Promise.withResolvers<AntigravityQuotaSnapshot>();",
              "\t\tlet subscribed = true;",
              "\t\tconst finish = (settle: () => void, cancel: boolean) => {",
              "\t\t\tif (!subscribed) return;",
              "\t\t\tsubscribed = false;",
              "\t\t\tactive.subscribers--;",
              "\t\t\tsignal?.removeEventListener(\"abort\", onAbort);",
              "\t\t\tsettle();",
              "\t\t\tif (cancel && active.subscribers === 0) active.controller.abort();",
              "\t\t};",
              "\t\tconst onAbort = () => finish(() => reject(abortError()), true);",
              "\t\tsignal?.addEventListener(\"abort\", onAbort, { once: true });",
              "\t\tif (signal?.aborted) onAbort();",
              "\t\tactive.snapshot.then(value => finish(() => resolve(value), false), error => finish(() => reject(error), false));",
              "\t\treturn promise;",
              "\t}",
              "",
              "\t// A separate short-lived process never races a user's warm ACP session.",
              "\tprivate async ompFetchQuota(apiKey: string | undefined, signal: AbortSignal): Promise<AntigravityQuotaSnapshot> {",
              "\t\tthis.assertActive();",
              "\t\tconst epoch = this.bindingEpoch;",
              "\t\tif (this.ensureAgent) await ensureAntigravityAcpReady();",
              "\t\tif (signal.aborted) throw abortError();",
              "\t\tthis.assertEpoch(epoch);",
              "\t\tlet sessionId: string | undefined;",
              "\t\tlet text = \"\";",
              "\t\tconst quotaOptions = { cwd: process.cwd(), ompPurpose: \"quota\" as const };",
              "\t\tconst connection = this.createConnection({",
              "\t\t\t...quotaOptions,",
              "\t\t\tpromptIdleTimeoutMs: 30_000,",
              "\t\t\thandlers: {",
              "\t\t\t\tonUpdate: ({ sessionId: id, update }) => {",
              "\t\t\t\t\tif (id === sessionId && update.sessionUpdate === \"agent_message_chunk\" && update.content.type === \"text\") text += update.content.text;",
              "\t\t\t\t},",
              "\t\t\t\tonPermission: async () => ({ outcome: { outcome: \"cancelled\" } }),",
              "\t\t\t},",
              "\t\t});",
              "\t\ttry {",
              "\t\t\tconst initialize = await connection.initialize(signal);",
              "\t\t\tthis.assertEpoch(epoch);",
              "\t\t\tawait authenticateForCredential(connection, initialize, apiKey, signal);",
              "\t\t\tthis.assertEpoch(epoch);",
              "\t\t\tconst session = await connection.newSession(process.cwd(), signal);",
              "\t\t\tsessionId = session.sessionId;",
              "\t\t\tthis.assertEpoch(epoch);",
              "\t\t\tconst currentModel = sessionModels(session)?.currentModelId;",
              "\t\t\tif (currentModel) {",
              "\t\t\t\tawait connection.setModel(sessionId, currentModel, signal);",
              "\t\t\t\tthis.assertEpoch(epoch);",
              "\t\t\t}",
              "\t\t\tconst advertised = \"waitForUsageCommand\" in connection && typeof connection.waitForUsageCommand === \"function\" && await connection.waitForUsageCommand(sessionId, undefined, signal);",
              "\t\t\tif (signal.aborted) throw abortError();",
              "\t\t\tif (!advertised) {",
              "\t\t\t\tthrow new Error(\"Antigravity /usage was not advertised by this ACP runtime. No model prompt was sent.\");",
              "\t\t\t}",
              "\t\t\tif (signal.aborted) throw abortError();",
              "\t\t\tconst request = { sessionId, prompt: [{ type: \"text\" as const, text: \"/usage\" }] };",
              "\t\t\tconst response = await (\"promptWithoutUsageDeltas\" in connection && typeof connection.promptWithoutUsageDeltas === \"function\" ? connection.promptWithoutUsageDeltas(request, signal) : connection.prompt(request, signal));",
              "\t\t\tif (response.stopReason !== \"end_turn\") {",
              "\t\t\t\tthrow new AntigravityAcpError(\"protocol\", `Antigravity /usage stopped with reason ${response.stopReason}; its partial quota response was not parsed`);",
              "\t\t\t}",
              "\t\t\tif (signal.aborted) throw abortError();",
              "\t\t\treturn parseUsageQuota(text);",
              "\t\t} finally {",
              "\t\t\ttry { if (sessionId) await connection.discardSession?.(sessionId); } finally { await connection.close(); }",
              "\t\t}",
              "\t}",
              "",
              "\tasync loginGoogle(",
            ].join("\n"),
          },
          {
            name: "quota reset exhaustion",
            anchor: "\t\t\tthis.metrics.record(response, usage);",
            replacement: [
              "\t\t\tthis.metrics.record(response, usage);",
              "\t\t\tconst quota = response.stopReason === \"cancelled\" ? undefined : quotaExhaustion(activeWriter.message.content.map(block => block.type === \"text\" ? block.text : \"\").join(\"\"));",
              "\t\t\tif (quota) await this.ompThrowQuota(binding, quota);",
            ].join("\n"),
          },
          {
            name: "quota parked-work cleanup",
            anchor: "\tprivate async awaitContinuation(binding: Binding, signal?: AbortSignal): Promise<void> {",
            replacement: [
              "\tprivate async ompThrowQuota(binding: Binding, quota: { resetAt?: string }): Promise<never> {",
              "\t\tif (binding.permission || binding.pendingTools.size > 0) await this.invalidateBinding(binding);",
              "\t\tthrow new AntigravityAcpError(\"quota\", `Antigravity quota exceeded for ${binding.modelId}.${quota.resetAt ? ` Resets at ${quota.resetAt}.` : \"\"}`);",
              "\t}",
              "",
              "\tprivate async awaitContinuation(binding: Binding, signal?: AbortSignal): Promise<void> {",
            ].join("\n"),
          },

          {
            name: "quota cache logout invalidation",
            anchor: "\t\tawait this.closeBindings();\n\t\tthis.sessionStore?.clear();",
            replacement: "\t\tthis.disposed = true;\n\t\tthis.quotaCache = undefined;\n\t\tthis.quotaCacheOwner = undefined;\n\t\tawait this.closeBindings();\n\t\tthis.sessionStore?.clear();",
          },
          {
            name: "collect hidden seed text",
            anchor: "\tprivate consumeUpdate(binding: Binding | undefined, notification: SessionNotification): void {\n\t\tif (!binding || notification.sessionId !== binding.session.sessionId) return;",
            replacement: "\tprivate consumeUpdate(binding: Binding | undefined, notification: SessionNotification): void {\n\t\tif (!binding || notification.sessionId !== binding.session.sessionId) return;\n\t\tif (binding.ompSeeding && notification.update.sessionUpdate === \"agent_message_chunk\" && notification.update.content.type === \"text\") {\n\t\t\tbinding.ompSeedText = (binding.ompSeedText ?? \"\") + notification.update.content.text;\n\t\t}",
          },
          {
            name: "validated message fingerprint memo",
            anchor: 'return createHash("sha256").update(canonicalJson(value)).digest("hex");',
            replacement: 'return ompMessageFingerprintMemo(message, value, () => createHash("sha256").update(canonicalJson(value)).digest("hex"));',
          },
          {
            name: "stable instruction fingerprint",
            anchor: 'return createHash("sha256").update(currentSystemInstructions(context)).digest("hex");',
            replacement: 'return createHash("sha256").update(stableSystemInstructions(context)).digest("hex");',
          },
          {
            name: "import stable instruction fingerprint",
            anchor: 'import { type PromptParts, buildPromptParts, currentSystemInstructions } from "./stream/context.js";',
            replacement: 'import { type PromptParts, buildPromptParts, currentSystemInstructions, stableSystemInstructions, estimateContextTokens } from "./stream/context.js";',
          },
          {
            name: "context",
            anchor: "buildPromptParts(context, fresh, unseenStart)",
            replacement: "buildPromptParts(context, fresh, unseenStart, { contextWindow: model.contextWindow, maxTokens: model.maxTokens, policy: model.ompContextPolicy, sessionRouting: (binding.connection as any).toolRouting ? (binding.connection as any).toolRouting.channel === 'system-append' : supportsSessionRouting(binding.initialize) }, ompRetryResend)",
          },
          {
            name: "keep tool and plan status out of model reasoning",
            anchor: 'else if (activity.type === "tool" || activity.type === "plan") binding.writer.thinking(activity.text);',
            replacement: '// ACP tool and plan status are UI activity, not model reasoning.',
          },
          {
            name: "track ACP compaction against pending work",
            anchor: "\tprivate consumeUpdate(binding: Binding | undefined, notification: SessionNotification): void {\n\t\tif (!binding || notification.sessionId !== binding.session.sessionId) return;",
            replacement: "\tprivate consumeUpdate(binding: Binding | undefined, notification: SessionNotification): void {\n\t\tif (!binding || notification.sessionId !== binding.session.sessionId) return;\n\t\tif (notification.update.sessionUpdate === \"compaction_update\" || notification.update.sessionUpdate === \"compaction_summary_chunk\") {\n\t\t\tif (binding.permission || binding.pendingTools.size > 0) {\n\t\t\t\tbinding.needsReconstruction = true;\n\t\t\t\tbinding.ompCompactionInvalidated = true;\n\t\t\t}\n\t\t\treturn;\n\t\t}",
          },
          {
            name: "invalidate a compacted binding before continuation",
            anchor: "\t\tlet binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);\n\t\tawait this.modeChanges;",
            replacement: "\t\tlet binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);\n\t\tif (binding.ompCompactionInvalidated) {\n\t\t\tawait this.invalidateBinding(binding);\n\t\t\tbinding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);\n\t\t}\n\t\tawait this.modeChanges;",
          },
          {
            name: "refresh OMP context window on model change",
            anchor: "\t\t\tif (binding.modelId !== acpModelId) {\n\t\t\t\tawait binding.connection.setModel(binding.session.sessionId, acpModelId, options.signal);\n\t\t\t\tbinding.modelId = acpModelId;\n\t\t\t}",
            replacement: "\t\t\tif (binding.modelId !== acpModelId) {\n\t\t\t\ttry {\n\t\t\t\t\tawait binding.connection.setModel(binding.session.sessionId, acpModelId, options.signal);\n\t\t\t\t} catch (error) {\n\t\t\t\t\tawait this.invalidateBinding(binding);\n\t\t\t\t\tthrow error;\n\t\t\t\t}\n\t\t\t\tbinding.modelId = acpModelId;\n\t\t\t\t(binding.connection as any).setOmpContextWindow?.(binding.session.sessionId, model.contextWindow);\n\t\t\t}",
          },
          {
            name: "workspace and parked model boundaries",
            anchor: "if (binding.mode !== this.permissionMode || this.confirmedMode(binding) !== this.permissionMode ||\n\t\t\tbinding.toolFingerprint !== piToolFingerprint(tools)) {\n\t\t\tawait this.invalidateBinding(binding);\n\t\t\tbinding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);\n\t\t}",
            replacement: "const ompContinuation = Boolean(binding.turnCompletion) && (binding.permission !== undefined || binding.pendingTools.size > 0);\n\t\tif (binding.cwd !== process.cwd() ||\n\t\t\t(binding.turnCompletion && binding.modelId !== acpModelId) ||\n\t\t\tbinding.mode !== this.permissionMode || this.confirmedMode(binding) !== this.permissionMode ||\n\t\t\t(!ompContinuation && !this.ompCanSyncTools(binding, tools))) {\n\t\t\tawait this.invalidateBinding(binding);\n\t\t\tbinding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);\n\t\t}\n\t\tif (!ompContinuation) this.ompSyncTools(binding, tools);",
          },
          {
            name: "new request supersedes continuation",
            anchor: "\t\t// A permission tool result resumes the still-running ACP prompt rather than",
            replacement: [
              "\t\t// A new/edited user request is not a tool-result continuation of the",
              "\t\t// previous ACP prompt. Never let old pending results swallow it.",
              "\t\tif (binding.turnCompletion || binding.permission || binding.pendingTools.size > 0) {",
              "\t\t\tconst ompPrefixMessages = context.messages.slice(0, binding.pendingContextCount);",
              "\t\t\tconst ompPrefixFingerprint = messagesFingerprint(ompPrefixMessages);",
              "\t\t\tconst ompConversationPrefixFingerprint = messagesFingerprint(ompPrefixMessages.filter(message => message.role !== 'system'));",
              "\t\t\tconst ompNewUser = context.messages.findLastIndex(message => message.role === 'user') >= binding.pendingContextCount;",
              "\t\t\tconst ompPrefixChanged = ompPrefixFingerprint !== binding.pendingContextFingerprint;",
              "\t\t\tconst ompConversationPrefixChanged = binding.pendingConversationFingerprint === undefined ? ompPrefixChanged : ompConversationPrefixFingerprint !== binding.pendingConversationFingerprint;",
              "\t\t\tif (ompNewUser || ompConversationPrefixChanged) {",
              "\t\t\t\tconst prefixMatches = context.messages.length >= binding.pendingContextCount &&",
              "\t\t\t\t\t(!ompPrefixChanged || (binding.pendingConversationFingerprint !== undefined &&",
              "\t\t\t\t\t\tompConversationPrefixFingerprint === binding.pendingConversationFingerprint &&",
              "\t\t\t\t\t\tbinding.instructionsFingerprint !== undefined && binding.instructionsFingerprint === instructionFingerprint(context)));",
              "\t\t\t\t// Queue mode can safely wait only for a streaming turn with no",
              "\t\t\t\t// parked tool/permission; those need the existing steer drain.",
              "\t\t\t\tconst ompQueueSteer = steerMode() === 'queue' &&",
              "\t\t\t\t\tBoolean(binding.turnCompletion) && !binding.permission && binding.pendingTools.size === 0 && !binding.ompSeeding;",
              "\t\t\t\tif (ompQueueSteer) {",
              "\t\t\t\t\tif (prefixMatches) binding.connection.muteSteerChunks?.(binding.session.sessionId);",
              "\t\t\t\t} else {",
              "\t\t\t\t\tconst drained = prefixMatches && await drainCancelledTurn(binding, () => abortTurn(binding), options.signal);",
              "\t\t\t\t\tif (!drained || !binding.connection.process.alive || binding.needsReconstruction ||",
              "\t\t\t\t\t\t!['cancelled', 'end_turn', 'max_turn_requests', 'max_tokens'].includes(binding.ompTerminalStopReason)) {",
              "\t\t\t\t\t\tawait this.invalidateBinding(binding);",
              "\t\t\t\t\t}",
              "\t\t\t\t\tif (drained && prefixMatches) {",
              "\t\t\t\t\t\tthis.ompSyncTools(binding, tools);",
              "\t\t\t\t\t\tbinding.historyFingerprint = messagesFingerprint(context.messages.slice(0, binding.messageCount));",
              "\t\t\t\t\t}",
              "\t\t\t\t\tbinding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);",
              "\t\t\t\t}",
              "\t\t\t}",
              "\t\t}",
              "",
              "\t\t// A permission tool result resumes the still-running ACP prompt rather than",
            ].join("\n"),
          },
          {
            name: "checkpoint acknowledged cancellation",
            anchor: "if (isAbort(error) || binding.abortRequested) abortTurn(binding);",
            replacement: [
              "if (isAbort(error) || binding.abortRequested) {",
              "\t\t\t\tabortTurn(binding);",
              "\t\t\t\tif (binding.connection.process.alive && !binding.ompInvalidated && !binding.needsReconstruction && !binding.ompSeeding &&",
              "\t\t\t\t\t['cancelled', 'end_turn', 'max_turn_requests', 'max_tokens'].includes(binding.ompTerminalStopReason)) {",
              "\t\t\t\t\tconst ompWasWarm = binding.messageCount > 0;",
              "\t\t\t\t\tbinding.messageCount = binding.pendingContextCount;",
              "\t\t\t\t\tbinding.historyFingerprint = binding.pendingContextFingerprint;",
              "\t\t\t\t\tbinding.ompConversationFingerprint = binding.pendingConversationFingerprint;",
              "\t\t\t\t\tbinding.expectedAssistantFingerprint = messageFingerprint((binding.writer ?? writer).message);",
              "\t\t\t\t\tbinding.ompExpectedAssistantNormalized = messageFingerprint(this.ompNormalizeAssistantForBoundary((binding.writer ?? writer).message));",
              "\t\t\t\t\tbinding.ompCancelledCheckpoint = true;",
              "\t\t\t\t\tbinding.ompCancelledHadOutput = (binding.writer ?? writer).message.content.length > 0;",
              "\t\t\t\t\tbinding.ompExpectedAssistantHasOutput = binding.ompCancelledHadOutput;",
              "\t\t\t\t\tbinding.ompInFlight = false;",
              "\t\t\t\t\ttry { this.persistBinding(binding); } catch (checkpointError) { await this.invalidateBinding(binding); throw checkpointError; }",
              "\t\t\t\t\tif (ompWasWarm) binding.connection.confirmReplacement?.(key, binding.session.sessionId);",
              "\t\t\t\t} else await this.invalidateBinding(binding);",
              "\t\t\t} else if (ompDispatched && !binding.ompInvalidated && error instanceof AntigravityAcpError && error.code === \"quota\") {",
              "\t\t\t\tbinding.ompInFlight = false;",
              "\t\t\t\ttry { this.persistBinding(binding); } catch (checkpointError) { await this.invalidateBinding(binding); throw checkpointError; }",
              "\t\t\t} else if (ompDispatched && !binding.ompInvalidated) await this.invalidateBinding(binding);",
              "\t\t\telse binding.ompInFlight = false;",
            ].join("\n"),
          },
          {
            name: "reject duplicate active input without touching its owner",
            anchor: "\t\t// A permission tool result resumes the still-running ACP prompt rather than",
            replacement: [
              "\t\tif (binding.turnCompletion && !binding.abortRequested &&",
              "\t\t\tcontext.messages.length === binding.pendingContextCount &&",
              "\t\t\tmessagesFingerprint(context.messages) === binding.pendingContextFingerprint) {",
              "\t\t\tthrow new AntigravityAcpError('invalid_input', 'ACP request/continuation is already in progress for this session');",
              "\t\t}",
              "\t\t// A permission tool result resumes the still-running ACP prompt rather than",
            ].join("\n"),
          },
          {
            name: "remember queued duplicate admission",
            anchor: "const previous = this.queues.get(key) ?? Promise.resolve();",
            replacement: "const ompQueuedBehindTurn = this.queues.has(key);\n\t\tconst previous = this.queues.get(key) ?? Promise.resolve();",
          },
          {
            name: "reject an already completed queued snapshot before reconstruction",
            anchor: "// A queued caller may hold an obsolete binding after shutdown/mode changes.\n\t\t\tbinding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);",
            replacement: [
              "// A queued caller may hold an obsolete binding after shutdown/mode changes.",
              "\t\t\tbinding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);",
              "\t\t\tif (ompQueuedBehindTurn && binding.modelId === acpModelId && !binding.ompCancelledCheckpoint && binding.expectedAssistantFingerprint &&",
              "\t\t\t\tcontext.messages.length === binding.messageCount &&",
              "\t\t\t\tmessagesFingerprint(context.messages) === binding.historyFingerprint) {",
              "\t\t\t\tthrow new AntigravityAcpError('invalid_input', 'ACP request was already processed by the preceding turn; refusing duplicate dispatch');",
              "\t\t\t}",
            ].join("\n"),
          },
          {
            name: "reset cancellation acknowledgement per prompt",
            anchor: "binding.instructionsFingerprint = instructionFingerprint(context);",
            replacement: "binding.ompTerminalStopReason = undefined;\n\t\t\t" + "binding.instructionsFingerprint = instructionFingerprint(context);\n\t\t\tbinding.ompFallbackContextTokens = parts.estimatedContextTokens;",
          },
          {
            name: "record official terminal reason before abort handling",
            anchor: "if (binding.abortRequested) throw abortError();",
            replacement: "if (binding.ompInvalidated) throw new AntigravityAcpError('protocol', 'ACP session ownership was lost');\n\t\t\tbinding.ompTerminalStopReason = response.stopReason;\n\t\t\tif (binding.abortRequested) throw abortError();",
          },
          {
            name: "queue steering holds the active turn",
            anchor: "\t\t\t\tonTurnAbort = () => abortTurn(promptBinding);",
            replacement: [
              "\t\t\t\tonTurnAbort = () => {",
              "\t\t\t\t\tif (steerMode() === 'queue' && isSteerAbort(options.signal) && !promptBinding.ompSeeding) {",
              "\t\t\t\t\t\tpromptBinding.connection.muteSteerChunks?.(promptBinding.session.sessionId);",
              "\t\t\t\t\t} else abortTurn(promptBinding);",
              "\t\t\t\t};",
            ].join("\n"),
          },
          {
            name: "generated assistant boundary must match retained OMP history",
            anchor: "\t\t\tif (\n\t\t\t\tbinding.needsReconstruction || binding.mode !== this.permissionMode ||",
            replacement: [
              "\t\t\tif (this.ompCanSyncTools(binding, tools)) this.ompSyncTools(binding, tools);",
              "\t\t\tif (!binding.needsReconstruction && context.messages.length >= binding.messageCount &&",
              "\t\t\t\tmessagesFingerprint(context.messages.slice(0, binding.messageCount)) !== binding.historyFingerprint &&",
              "\t\t\t\tcontext.messages.slice(0, binding.messageCount).some(message => message.role === 'system') &&",
              "\t\t\t\tbinding.instructionsFingerprint !== undefined && binding.instructionsFingerprint === instructionFingerprint(context) &&",
              "\t\t\t\tbinding.ompConversationFingerprint !== undefined &&",
              "\t\t\t\tmessagesFingerprint(context.messages.slice(0, binding.messageCount).filter(message => message.role !== 'system')) === binding.ompConversationFingerprint) {",
              "\t\t\t\tbinding.historyFingerprint = messagesFingerprint(context.messages.slice(0, binding.messageCount));",
              "\t\t\t}",
              "\t\t\t// Only after accepting a non-textual system/tool delta can an",
              "\t\t\t// identical resend be recognized against the updated checkpoint.",
              "\t\t\tconst ompRetryResend = binding.messageCount > 0 &&",
              "\t\t\t\tcontext.messages.length === binding.messageCount &&",
              "\t\t\t\tmessagesFingerprint(context.messages) === binding.historyFingerprint;",
              "\t\t\tif (",
              "\t\t\t\tbinding.needsReconstruction || binding.cwd !== process.cwd() ||",
              "\t\t\t\t(binding.instructionsFingerprint !== undefined && binding.instructionsFingerprint !== instructionFingerprint(context)) ||",
              "\t\t\t\t(binding.expectedAssistantFingerprint && context.messages[binding.messageCount]?.role === 'assistant' &&",
              "\t\t\t\t\t!this.ompAssistantMatches(binding, context.messages[binding.messageCount])) ||",
              "\t\t\t\t((binding.ompExpectedAssistantHasOutput || (binding.ompCancelledCheckpoint && binding.ompCancelledHadOutput)) &&",
              "\t\t\t\t\tcontext.messages[binding.messageCount]?.role !== 'assistant' && !ompRetryResend) || binding.mode !== this.permissionMode ||",
            ].join("\n"),
          },
          {
            name: "assistant boundary skip uses normalized matcher",
            anchor: "binding.expectedAssistantFingerprint === messageFingerprint(expected)",
            replacement: "this.ompAssistantMatches(binding, expected)",
          },
          {
            name: "multi-step seed capabilities",
            anchor: "return { ...parts, prompt: output };",
            replacement: "return { ...parts, prompt: output, ...(parts.seedSteps ? { seedSteps: parts.seedSteps.map(step => adaptPromptToCapabilities({ prompt: step, messageCount: parts.messageCount, estimatedContextTokens: parts.estimatedContextTokens }, initialize).prompt) } : {}) };",
          },
          {
            name: "persist cancellation checkpoint flags",
            anchor: "acpModelId: binding.modelId,",
            replacement: "acpModelId: binding.modelId,\n\t\t\tompCancelledCheckpoint: binding.ompCancelledCheckpoint === true,\n\t\t\tompCancelledHadOutput: binding.ompCancelledHadOutput === true,\n\t\t\t...(binding.ompExpectedAssistantNormalized ? { ompExpectedAssistantNormalized: binding.ompExpectedAssistantNormalized } : {}),\n\t\t\t...(binding.instructionsFingerprint ? { ompInstructionsFingerprint: binding.instructionsFingerprint } : {}),\n\t\t\t...(binding.ompConversationFingerprint ? { ompConversationFingerprint: binding.ompConversationFingerprint } : {}),",
          },
          {
            name: "restore cancellation checkpoint flags",
            anchor: "messageCount: restored && saved ? saved.messageCount : 0,",
            replacement: "messageCount: restored && saved ? saved.messageCount : 0,\n\t\t\t\tompCancelledCheckpoint: restored && saved?.ompCancelledCheckpoint === true,\n\t\t\t\tompCancelledHadOutput: restored && saved?.ompCancelledHadOutput === true,\n\t\t\t\tompExpectedAssistantNormalized: restored ? saved?.ompExpectedAssistantNormalized : undefined,\n\t\t\t\tompConversationFingerprint: restored ? saved?.ompConversationFingerprint : undefined,",
          },
          {
            name: "restore instructions fingerprint",
            anchor: "instructionsFingerprint: undefined,",
            replacement: "instructionsFingerprint: restored ? saved?.ompInstructionsFingerprint : undefined,",
          },
          {
            name: "connection retirement",
            anchor: "if (!persistent) await this.dropBinding(key, binding);",
            replacement: "binding.ompSeeding = false;\n\t\t\tif (!persistent || !binding.connection.process.alive) await this.dropBinding(key, binding);",
          },
          {
            name: "cleanup retire",
            anchor: "const current = this.bindings.get(key);\n\t\tif (current && (await current) === binding",
            replacement: "if (removeSaved) binding.connection.retireForReplacement?.(key, binding.session.sessionId);\n\t\tconst current = this.bindings.get(key);\n\t\tif (current && (await current) === binding",
          },
          {
            name: "cleanup confirm",
            anchor: "this.persistBinding(binding);\n\t\t\tswitch (response.stopReason)",
            replacement: "if (response.stopReason !== 'cancelled') binding.ompCancelledCheckpoint = false;\n\t\t\tthis.persistBinding(binding);\n\t\t\tif (response.stopReason === 'end_turn' || (!fresh && (response.stopReason === 'max_tokens' || response.stopReason === 'max_turn_requests'))) { binding.connection.confirmReplacement?.(key, binding.session.sessionId); }\n\t\t\tif (!persistent) { binding.connection.discardSession?.(binding.session.sessionId); await this.dropBinding(key, binding); }\n\t\t\tswitch (response.stopReason)",
          },
          {
            name: "discard discovery session",
            anchor: "const session = await connection.newSession(process.cwd(), signal);\n\t\t\tthis.assertEpoch(epoch);\n\t\t\treturn sessionModels(session)?.availableModels ?? [];",
            replacement: "const session = await connection.newSession(process.cwd(), signal);\n\t\t\ttry { this.assertEpoch(epoch); return sessionModels(session)?.availableModels ?? []; } finally { await connection.discardSession?.(session.sessionId); }",
          },
          {
            name: "discard login verification session",
            anchor: "await authentication;\n\t\t\tthis.assertEpoch(epoch);\n\t\t\tawait connection.newSession(process.cwd(), signal);",
            replacement: "await authentication;\n\t\t\tthis.assertEpoch(epoch);\n\t\t\tconst session = await connection.newSession(process.cwd(), signal);\n\t\t\ttry { this.assertEpoch(epoch); } finally { await connection.discardSession?.(session.sessionId); }",
          },
          {
            name: "discard api-key verification session",
            anchor: "await authenticateForCredential(connection, initialize, apiKey, signal);\n\t\t\tthis.assertEpoch(epoch);\n\t\t\tawait connection.newSession(process.cwd(), signal);",
            replacement: "await authenticateForCredential(connection, initialize, apiKey, signal);\n\t\t\tthis.assertEpoch(epoch);\n\t\t\tconst session = await connection.newSession(process.cwd(), signal);\n\t\t\ttry { this.assertEpoch(epoch); } finally { await connection.discardSession?.(session.sessionId); }",
          },
          {
            name: "refresh permission fallback context estimate",
            anchor: "\t\t\t\tbinding.permission = undefined;\n\t\t\t\tclearTimeout(pending.timer);",
            replacement: "\t\t\t\tbinding.permission = undefined;\n\t\t\t\tclearTimeout(pending.timer);\n\t\t\t\tbinding.ompFallbackContextTokens = estimateContextTokens(context);",
          },
          {
            name: "include seed usage",
            anchor: "const usage = usageFromPrompt(response);",
            replacement: "const usage = usageFromPrompt(response, binding.ompFallbackContextTokens);\n\t\t\tif (ompSeedUsage) {\n\t\t\t\tusage.input += ompSeedUsage.input;\n\t\t\t\tusage.output += ompSeedUsage.output;\n\t\t\t\tusage.cacheRead += ompSeedUsage.cacheRead;\n\t\t\t\tusage.cacheWrite += ompSeedUsage.cacheWrite;\n\t\t\t\tusage.totalTokens += ompSeedUsage.totalTokens;\n\t\t\t\tif (ompSeedUsage.reasoning !== undefined) usage.reasoning = (usage.reasoning ?? 0) + ompSeedUsage.reasoning;\n\t\t\t}",
          },
          {
            name: "deliver orphaned relay results in a new turn",
            anchor: "\t\t\t} else {\n\t\t\t\tbinding.writer = writer;\n\t\t\t\tthis.noteContinuationInstructions(binding, context);\n\t\t\t\tbinding.pendingContextCount = context.messages.length;\n\t\t\t\tbinding.pendingContextFingerprint = messagesFingerprint(context.messages);\n\t\t\t\tfor (const { pending, message } of results) {",
            replacement: "\t\t\t} else if (!binding.turnCompletion) {\n\t\t\t\tcancelPiTools(binding, \"The previous ACP turn ended before the relayed tool result arrived; the result will be replayed as history in a new continuation\");\n\t\t\t\tbinding.pendingTools.clear();\n\t\t\t\tbinding.needsReconstruction = true;\n\t\t\t} else {\n\t\t\t\tbinding.writer = writer;\n\t\t\t\tthis.noteContinuationInstructions(binding, context);\n\t\t\t\tbinding.pendingContextCount = context.messages.length;\n\t\t\t\tbinding.pendingContextFingerprint = messagesFingerprint(context.messages);\n\t\t\t\tbinding.ompFallbackContextTokens = estimateContextTokens(context);\n\t\t\t\tfor (const { pending, message } of results) {",
          },
          {
            name: "begin relay turn",
            anchor: "\t\t\tbinding.turnCompletion = new Promise<void>((resolve) => {",
            replacement: "\t\t\tbinding.relay.beginTurn();\n\t\t\tbinding.turnCompletion = new Promise<void>((resolve) => {",
          },
          {
            name: "end relay turn",
            anchor: "\t\t\tcompleteTurn?.();\n\t\t\tbinding.turnCompletion = undefined;",
            replacement: "\t\t\tcompleteTurn?.();\n\t\t\tbinding.relay.endTurn();\n\t\t\tbinding.turnCompletion = undefined;\n\t\t\tbinding.ompFallbackContextTokens = undefined;",
          },
          {
            name: "queued relay fingerprint check",
            anchor: "binding.toolFingerprint !== piToolFingerprint(tools) ||",
            replacement: "!this.ompCanSyncTools(binding, tools) ||",
          },
          {
            name: "relay-aware MCP bridge",
            anchor: "\t\t\tlet mcpServer;\n\t\t\tif (tools.length > 0 && initialize.agentCapabilities?.mcpCapabilities?.http === true) {\n\t\t\t\tbridge = new PiMcpBridge({\n\t\t\t\t\ttools,\n\t\t\t\t\tonCall: (invocation) => this.requestPiTool(binding, invocation),\n\t\t\t\t});\n\t\t\t\tmcpServer = await bridge.start();\n\t\t\t}\n\t\t\tconst mcpServers = mcpServer ? [mcpServer] : [];",
            replacement: "\t\t\tconst relayConfig = this.ompRelayConfig();\n\t\t\tconst relay = new ToolRelay(relayConfig);\n\t\t\tconst relayCollision = relayConfig.enabled ? tools.find(tool => projectedMcpName(tool.name) === TOOL_RELAY_CONTROL_NAME) : undefined;\n\t\t\tif (relayCollision) throw new AntigravityAcpError(\"invalid_input\", \"Tool \" + relayCollision.name + \" collides with the relay control tool \" + TOOL_RELAY_CONTROL_NAME + \"; rename it or disable OMP_ACP_TOOL_RELAY_MS\");\n\t\t\tlet mcpServer;\n\t\t\tlet relayServer;\n\t\t\tif (tools.length > 0 && initialize.agentCapabilities?.mcpCapabilities?.http === true) {\n\t\t\t\tbridge = new PiMcpBridge({\n\t\t\t\t\ttools,\n\t\t\t\t\tonCall: (invocation) => relay.call(invocation, () => this.requestPiTool(binding, invocation)),\n\t\t\t\t});\n\t\t\t\tmcpServer = await bridge.start();\n\t\t\t\tif (relayConfig.enabled) {\n\t\t\t\t\trelayBridge = new PiMcpBridge({\n\t\t\t\t\t\ttools: [relayControlTool],\n\t\t\t\t\t\tonCall: (invocation) => {\n\t\t\t\t\t\t\tconst callId = invocation.arguments.call_id;\n\t\t\t\t\t\t\treturn typeof callId === \"string\" && callId\n\t\t\t\t\t\t\t\t? relay.await(callId)\n\t\t\t\t\t\t\t\t: Promise.resolve({ content: [{ type: \"text\", text: \"call_id must be a non-empty string\" }], isError: true });\n\t\t\t\t\t\t},\n\t\t\t\t\t});\n\t\t\t\t\trelayServer = await relayBridge.start();\n\t\t\t\t\tif (relayServer) relayServer.name = \"pi-relay\";\n\t\t\t\t}\n\t\t\t}\n\t\t\tconst mcpServers = [];\n\t\t\tif (mcpServer) mcpServers.push(mcpServer);\n\t\t\tif (relayServer) mcpServers.push(relayServer);",
          },
          {
            name: "close relay bridge on process exit",
            anchor: "void bridge?.close().catch(() => undefined);",
            replacement: "void bridge?.close().catch(() => undefined);\n\t\t\t\tvoid relayBridge?.close().catch(() => undefined);",
          },
          {
            name: "relay threshold field",
            anchor: "\tprivate permissionMode: PermissionMode;",
            replacement: "\tprivate permissionMode: PermissionMode;\n\tprivate readonly ompRelayThresholdMs: number | undefined;",
          },
          {
            name: "relay threshold constructor injection",
            anchor: "\tconstructor(\n\t\tconnectionFactory?: AntigravityConnectionFactory,\n\t\tpermissionMode: PermissionMode = \"yolo\",\n\t\tsessionStore?: AcpSessionStore,\n\t) {",
            replacement: "\tconstructor(\n\t\tconnectionFactory?: AntigravityConnectionFactory,\n\t\tpermissionMode: PermissionMode = \"yolo\",\n\t\tsessionStore?: AcpSessionStore,\n\t\trelayThresholdMs?: number,\n\t) {\n\t\tthis.ompRelayThresholdMs = relayThresholdMs;",
          },
          {
            name: "classify provider refusal",
            anchor: "\t\t\tswitch (response.stopReason) {\n\t\t\t\tcase \"cancelled\":\n\t\t\t\t\tthrow abortError();\n\t\t\t\tcase \"max_tokens\":\n\t\t\t\tcase \"max_turn_requests\":\n\t\t\t\t\tactiveWriter.done(\"length\");\n\t\t\t\t\tbreak;\n\t\t\t\tdefault:\n\t\t\t\t\tactiveWriter.done(\"stop\");\n\t\t\t}",
            replacement: "\t\t\tswitch (response.stopReason) {\n\t\t\t\tcase \"cancelled\":\n\t\t\t\t\tthrow abortError();\n\t\t\t\tcase \"refusal\":\n\t\t\t\t\tthrow new AcpFailure(\"refusal\", \"Antigravity refused the request\");\n\t\t\t\tcase \"max_tokens\":\n\t\t\t\tcase \"max_turn_requests\":\n\t\t\t\t\tactiveWriter.done(\"length\");\n\t\t\t\t\tbreak;\n\t\t\t\tdefault:\n\t\t\t\t\tactiveWriter.done(\"stop\");\n\t\t\t}",
          },
          {
            name: "close relay bridge on runtime shutdown",
            anchor: "\t\t\t\tvalue.bridge?.close() ?? Promise.resolve(),",
            replacement: "\t\t\t\tvalue.bridge?.close() ?? Promise.resolve(),\n\t\t\t\tvalue.relayBridge?.close() ?? Promise.resolve(),",
          },
          {
            name: "cancel relay records with pending tools",
            anchor: "function cancelPiTools(binding: Binding, reason: string): void {\n\tif (binding.toolBatchTimer) clearTimeout(binding.toolBatchTimer);",
            replacement: "function cancelPiTools(binding: Binding, reason: string): void {\n\tbinding.relay.cancelAll(reason);\n\tif (binding.toolBatchTimer) clearTimeout(binding.toolBatchTimer);",
          },
        ];
        let contents = await fs.readFile(file, "utf8");
        for (const patch of patches) {
          if (contents.split(patch.anchor).length !== 2) {
            throw new Error(`Pinned upstream ${patch.name} seam changed; review compatibility`);
          }
          contents = contents.replace(patch.anchor, patch.replacement);
        }
        // Convert every store/checkpoint call at its owning async boundary.
        // Never hide an asynchronous write behind the upstream synchronous API.
        const asyncPatches = [
          ["private persistBinding(binding: Binding): void", "private async persistBinding(binding: Binding): Promise<void>"],
          ["private noteContinuationInstructions(binding: Binding, context: Context): void", "private async noteContinuationInstructions(binding: Binding, context: Context): Promise<void>"],
          ["private async closeBindings(): Promise<void> {", "private async closeBindings(): Promise<void> {\n for (const request of this.quotaInFlights) request.controller.abort(); const closingTurns = [...this.resolvedBindings].flatMap(binding => binding.turnCompletion ? [binding.turnCompletion] : []);\n const ephemeralBindings = [...this.resolvedBindings].filter(binding => !binding.piSessionId);\n await Promise.allSettled(ephemeralBindings.map(async binding => binding.connection.discardSession?.(binding.session.sessionId)));"],
          ["\t\tthis.persistBinding(createdBinding);", "\t\tthis.persistBinding(createdBinding);\n\t\tthis.assertEpoch(epoch);"],
          ["if (removeSaved && binding.piSessionId) this.sessionStore?.remove(binding.piSessionId);\n\t\t\tthis.bindings.delete(key);", "this.bindings.delete(key);\n\t\t\tif (removeSaved && binding.piSessionId) this.sessionStore?.remove(binding.piSessionId);"],
        ];
        for (const [anchor, replacement] of asyncPatches) {
          if (contents.split(anchor).length !== 2) throw new Error(`Pinned async store seam changed: ${anchor}`);
          contents = contents.replace(anchor, replacement);
        }
        for (const [anchor, replacement, count] of [
          ["this.persistBinding(", "await this.persistBinding(", 4],
          ["this.noteContinuationInstructions(binding, context);", "const continuationTurn = binding.turnCompletion; await this.noteContinuationInstructions(binding, context); if (!continuationTurn || binding.turnCompletion !== continuationTurn || binding.abortRequested || options.signal?.aborted || !binding.connection.process.alive) throw abortError();", 2],
          ["this.sessionStore?.", "await this.sessionStore?.", 8],
        ]) {
          if (contents.split(anchor).length !== count + 1) throw new Error(`Pinned store call sites changed: ${anchor}`);
          contents = contents.replaceAll(anchor, replacement);
        }
        // Continuity transactions are adapter-owned. Keep explicit pinned seams
        // so an upstream update cannot silently bypass the write-ahead marker.
        const continuityPatches = [
          ['interface Binding {', 'interface Binding {\n ompFallbackContextTokens?: number; ompInFlight: boolean; ompInvalidated: boolean; ompCompactionInvalidated?: boolean; ompSeeding?: boolean; ompSeedText?: string; ompDropPromise?: Promise<void>; ompExpectedAssistantHasOutput: boolean; ompExpectedAssistantNormalized?: string; ompConversationFingerprint?: string; ompReleaseLease?: (wait?: boolean) => Promise<void>; pendingConversationFingerprint?: string; relay: ToolRelay; relayBridge?: PiMcpBridge; relayFingerprint: string;'],
          ['let completeTurn: (() => void) | undefined;', 'let ompDispatched = false;\n\t\tlet completeTurn: (() => void) | undefined;'],
          ['if (existing) return existing;', `if (existing) {
            const value = await existing;
            (value.connection as any).setOmpContextWindow?.(value.session.sessionId, model.contextWindow);
            if (!value.ompInvalidated) return value;
            await value.ompDropPromise;
            if (this.bindings.get(key) === existing) this.bindings.delete(key);
            return this.getBinding(key, model, acpModelId, apiKey, writer, tools, signal);
          }`],
          ['if (value === createdBinding && this.bindings.get(key) === current) this.bindings.delete(key);',
            'if (value === createdBinding && this.bindings.get(key) === current && !createdBinding.ompInvalidated) this.bindings.delete(key);'],
          ['let bridge: PiMcpBridge | undefined;', 'let bridge: PiMcpBridge | undefined;\n\t\tlet relayBridge: PiMcpBridge | undefined;\n\t\tconst piSessionId = key.startsWith("sid:") ? key.slice(4) : undefined;\n\t\tlet session: AcpNewSessionResponse | undefined;\n\t\tlet restored = false;'],
          ['const piSessionId = key.startsWith("sid:") ? key.slice(4) : undefined;\n\t\t\tconst saved = piSessionId ? await this.sessionStore?.get(piSessionId) : undefined;\n\t\t\tlet session: AcpNewSessionResponse | undefined;\n\t\t\tlet restored = false;', `let saved = piSessionId ? await this.sessionStore?.get(piSessionId) : undefined;
            if (saved && (saved.ompCheckpointVersion !== 1 || saved.ompInFlight !== false)) {
              await connection.retireForReplacement?.(key, saved.acpSessionId);
              await this.ompRemoveSaved(saved.piSessionId, saved.acpSessionId);
              saved = undefined;
            }`],
          ['const createdBinding: Binding = {', `const createdBinding: Binding = {
            ompInFlight: false, ompInvalidated: false,
            ompReleaseLease: releaseLease,
            ompExpectedAssistantHasOutput: restored && (saved?.ompExpectedAssistantHasOutput === true ||
              (saved?.ompExpectedAssistantHasOutput === undefined && Boolean(saved?.expectedAssistantFingerprint))),
            relay, relayBridge, relayFingerprint: relayConfig.fingerprint,
            pendingConversationFingerprint: messagesFingerprint([]),`],
          ['const response = await binding.connection.prompt(', `if (options.signal?.aborted) throw abortError();
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
                  if (seedResponse.stopReason !== 'end_turn') throw new AntigravityAcpError('protocol', \`ACP seed step stopped early with \${seedResponse.stopReason}\`);
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
            const response = await binding.connection.prompt(`],
          ['binding.expectedAssistantFingerprint = messageFingerprint(activeWriter.message);', `binding.ompConversationFingerprint = binding.pendingConversationFingerprint;
            binding.expectedAssistantFingerprint = messageFingerprint(activeWriter.message.content.length
              ? activeWriter.message : { ...activeWriter.message, content: [{ type: 'text', text: '' }] });
            binding.ompExpectedAssistantNormalized = messageFingerprint(this.ompNormalizeAssistantForBoundary(activeWriter.message));
            binding.ompExpectedAssistantHasOutput = activeWriter.message.content.some(block => block.type !== 'text' || block.text.length > 0);
            binding.ompInFlight = false;`],
          ['if (!binding.piSessionId) return;', 'if (!binding.piSessionId || binding.ompInvalidated) return;'],
          ['acpModelId: binding.modelId,', 'acpModelId: binding.modelId,\n ompCheckpointVersion: 1, ompInFlight: binding.ompInFlight === true, ompExpectedAssistantHasOutput: binding.ompExpectedAssistantHasOutput === true,'],
          ['await this.sessionStore?.remove(saved.piSessionId);',
            'await this.ompRemoveSaved(saved.piSessionId, saved.acpSessionId);'],
          ['session ??= await connection.newSession(cwd, signal, mcpServers);',
            'if (!session && saved) { await connection.retireForReplacement?.(key, saved.acpSessionId); await this.ompRemoveSaved(saved.piSessionId, saved.acpSessionId); }\n\t\t\tsession ??= await connection.newSession(cwd, signal, mcpServers);'],
          ['if (!supportsMode(session, mode)) {\n\t\t\t\tif (piSessionId) await this.sessionStore?.remove(piSessionId);',
            'if (!supportsMode(session, mode)) {\n\t\t\t\tif (restored && saved) { await connection.retireForReplacement?.(key, saved.acpSessionId); await this.ompRemoveSaved(saved.piSessionId, saved.acpSessionId); } else await connection.discardSession?.(session.sessionId);'],
          ['if (binding.needsReconstruction) { await this.sessionStore?.remove(binding.piSessionId); return; }',
            'if (binding.needsReconstruction) { binding.connection.retireForReplacement?.(binding.key, binding.session.sessionId); await this.ompRemoveSaved(binding.piSessionId, binding.session.sessionId); return; }'],
          ['binding.needsReconstruction = true;\n\t\t\tif (binding.piSessionId) await this.sessionStore?.remove(binding.piSessionId);',
            'binding.needsReconstruction = true;\n\t\t\tbinding.connection.retireForReplacement?.(binding.key, binding.session.sessionId);\n\t\t\tif (binding.piSessionId) await this.ompRemoveSaved(binding.piSessionId, binding.session.sessionId);'],
        ];
        for (const [anchor, replacement] of continuityPatches) {
          if (contents.split(anchor).length !== 2) throw new Error(`Pinned continuity seam changed: ${anchor}`);
          contents = contents.replace(anchor, replacement);
        }
        const pendingFingerprintAnchor = "binding.pendingContextFingerprint = messagesFingerprint(context.messages);";
        if (contents.split(pendingFingerprintAnchor).length !== 4) throw new Error("Pinned pending context fingerprint seams changed");
        contents = contents.replaceAll(pendingFingerprintAnchor,
          pendingFingerprintAnchor + "\n\t\t\tbinding.pendingConversationFingerprint = messagesFingerprint(context.messages.filter(message => message.role !== 'system'));");
        const leasePatches = [
          ['const connection = this.createConnection({\n\t\t\tcwd,', 'let leaseLost = false;\n\t\tlet releaseLease: (() => Promise<void>) | undefined;\n\t\tconst connection = this.createConnection({\n\t\t\tcwd,'],
          ['onPermission: (request) => this.requestPermission(binding, request),\n\t\t\t},\n\t\t});\n\t\ttry {\n\t\t\tconst initialize = await connection.initialize();', `onPermission: (request) => this.requestPermission(binding, request),
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
\t\t\tconst initialize = await connection.initialize();`],
          ['void connection.process.exited.then(() => {\n\t\t\t\tcancelPermission(createdBinding);', `void connection.process.exited.then(() => {
            const completion = createdBinding.turnCompletion;
            const retiring = createdBinding.ompDropPromise;
            void Promise.resolve(retiring ?? completion).then(() => createdBinding.ompReleaseLease?.()).catch(() => {});
\t\t\t\tcancelPermission(createdBinding);`],
          ['binding = createdBinding;\n\t\t\tawait this.persistBinding(createdBinding);', `binding = createdBinding;
            (binding.connection as any).setOmpContextWindow?.(binding.session.sessionId, model.contextWindow);
            if (leaseLost) throw new AntigravityAcpError('protocol', 'ACP session ownership was lost during initialization');
\t\t\tawait this.persistBinding(createdBinding);`],
          ['await Promise.allSettled([connection.close(), bridge?.close() ?? Promise.resolve()]);\n\t\t\tthrow error;', `if (session?.sessionId && !restored) {
              if (piSessionId) await this.ompRemoveSaved(piSessionId, session.sessionId).catch(() => {});
              try { await connection.discardSession?.(session.sessionId); } catch {}
            }
            await Promise.allSettled([connection.close(), bridge?.close() ?? Promise.resolve(), relayBridge?.close() ?? Promise.resolve()]);
            await releaseLease?.();
\t\t\tthrow error;`],
        ];
        for (const [anchor, replacement] of leasePatches) {
          if (contents.split(anchor).length !== 2) throw new Error(`Pinned session lease seam changed: ${anchor}`);
          contents = contents.replace(anchor, replacement);
        }
        // Fallbacks after incomplete tools/permissions must not reload the same
        // backend. The two owning branches share this exact adjacent seam.
        const fallback = 'await this.dropBinding(key, binding);\n\t\t\t\tbinding = await this.getBinding(';
        if (contents.split(fallback).length !== 3) throw new Error('Pinned incomplete continuation fallbacks changed');
        contents = contents.replaceAll(fallback, 'await this.invalidateBinding(binding);\n\t\t\t\tbinding = await this.getBinding(');
        const claimStart = 'binding.writer = writer;\n\t\t\t\tconst continuationTurn = binding.turnCompletion;';
        const claimEnd = 'await this.awaitContinuation(binding, options.signal);\n\t\t\t\treturn;';
        if (contents.split(claimStart).length !== 3 || contents.split(claimEnd).length !== 3) throw new Error('Pinned continuation ownership seams changed');
        contents = contents.replaceAll(claimStart, 'await claimContinuation(binding, async () => {\n\t\t\t\t' + claimStart)
          .replaceAll(claimEnd, '}, () => this.invalidateBinding(binding));\n\t\t\t\tthis.ompSyncTools(binding, tools);\n\t\t\t\tawait this.awaitContinuation(binding, options.signal);\n\t\t\t\treturn;');
        const dropPattern = /\tprivate async dropBinding\([\s\S]*?\n\tprivate confirmedMode\(/g;
        if ([...contents.matchAll(dropPattern)].length !== 1) throw new Error('Pinned binding teardown seam changed');
        contents = contents.replace(dropPattern, `\tprivate async ompRemoveSaved(piSessionId: string, acpSessionId: string): Promise<void> {
          if (typeof this.sessionStore?.removeIfMatches === 'function') await this.sessionStore.removeIfMatches(piSessionId, acpSessionId);
          else await this.sessionStore?.remove(piSessionId);
        }
        private async dropBinding(key: string, binding: Binding, removeSaved = false): Promise<void> {
          if (removeSaved) binding.ompInvalidated = true;
          if (binding.ompDropPromise) {
            await binding.ompDropPromise;
            if (!binding.piSessionId) {
              binding.connection.discardSession?.(binding.session.sessionId);
            } else if (removeSaved) {
              binding.connection.retireForReplacement?.(key, binding.session.sessionId);
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
                binding.connection.discardSession?.(binding.session.sessionId);
              } else if (removeSaved) {
                binding.connection.retireForReplacement?.(key, binding.session.sessionId);
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
        private confirmedMode(`);
        const flushAnchor = "\n\tprivate async runQueued(";
        const beforeQueue = contents.slice(0, contents.indexOf(flushAnchor));
        const endClose = beforeQueue.lastIndexOf("\n\t}");
        // Await active turns' checkpoint writes, not queued callers which may
        // themselves be waiting for this permission-mode change to complete.
        contents = contents.slice(0, endClose) + "\n\t\tawait Promise.allSettled(closingTurns);\n\t\tawait Promise.allSettled(pending.map(async value => (await value).ompReleaseLease?.()));\n\t\tawait this.sessionStore?.flush?.();" + contents.slice(endClose);
        const classStart = contents.indexOf("export class AntigravityRuntime {");
        const helpersStart = contents.indexOf("\nfunction messagesFingerprint(");
        if (classStart < 0 || helpersStart < classStart) throw new Error("Pinned runtime class seam changed");
        const methods = contents.slice(classStart, helpersStart)
          .replaceAll("messagesFingerprint(", "this.ompMessagesFingerprint(")
          .replaceAll("messageFingerprint(", "this.ompMessageFingerprint(")
          .replaceAll("piToolFingerprint(", "this.ompToolsFingerprint(");
        contents = contents.slice(0, classStart) + methods + contents.slice(helpersStart);
        contents = contents.replace("export class AntigravityRuntime {", `export class AntigravityRuntime {
          private readonly ompSystemMemo = createStructuredFingerprintMemo();
          private readonly ompToolsMemo = createStructuredFingerprintMemo();
          private ompMessagesFingerprint(messages: Context["messages"]): string { return messagesFingerprint(messages, this.ompSystemMemo); }
          private ompMessageFingerprint(message: Context["messages"][number]): string { return messageFingerprint(message, this.ompSystemMemo); }
          private ompToolsFingerprint(tools: NonNullable<Context["tools"]>): string { return this.ompToolsMemo(tools, () => piToolFingerprint(tools)); }
          private ompRelayConfig() {
            const base = resolveRelayConfig();
            return this.ompRelayThresholdMs === undefined
              ? base
              : { ...base, thresholdMs: this.ompRelayThresholdMs, fingerprint: \`\${base.fingerprint}:test:\${this.ompRelayThresholdMs}\` };
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
              (binding.bridge as any).updateTools?.(tools);
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
            const rawContent = typeof (message as any).content === "string"
              ? [{ type: "text", text: (message as any).content }]
              : Array.isArray(message.content) ? message.content : [];
            const filtered = rawContent
              .filter((block: any) => block && (
                (block.type === "text" && typeof block.text === "string" && block.text.length > 0) ||
                block.type === "toolCall"
              ))
              .map((block: any) => block.type === "toolCall"
                ? { type: "toolCall" as const, id: block.id, name: block.name, arguments: block.arguments }
                : { type: "text" as const, text: block.text });
            const content = filtered.length ? filtered : [{ type: "text" as const, text: "" }];
            return {
              ...message,
              role: "assistant",
              provider: "antigravity-acp",
              model: "",
              content: content as any,
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
        `);
        const fingerprintPatches = [
          ['function messagesFingerprint(messages: Context["messages"]): string {', 'function messagesFingerprint(messages: Context["messages"], systemMemo?: any): string {'],
          ['const fingerprints = messages.map(messageFingerprint);', 'const fingerprints = messages.map(message => messageFingerprint(message, systemMemo));'],
          ['function messageFingerprint(message: Context["messages"][number]): string {', 'function messageFingerprint(message: Context["messages"][number], systemMemo?: any): string {'],
          ['return ompMessageFingerprintMemo(message, value, () => createHash("sha256").update(canonicalJson(value)).digest("hex"));', 'const compute = () => createHash("sha256").update(canonicalJson(value)).digest("hex"); return message.role === "system" && systemMemo ? systemMemo(value, compute) : ompMessageFingerprintMemo(message, value, compute);'],
          ['await this.sessionStore?.flush?.();', 'try { await this.sessionStore?.flush?.(); } finally { this.ompSystemMemo.clear(); this.ompToolsMemo.clear(); }'],
        ];
        for (const [anchor, replacement] of fingerprintPatches) {
          if (contents.split(anchor).length !== 2) throw new Error(`Pinned structured fingerprint seam changed: ${anchor}`);
          contents = contents.replace(anchor, replacement);
        }
        contents = `import { supportsSessionRouting } from ${JSON.stringify(path.join(root, "extension/tool-routing.ts"))};\n` + contents;
        contents = `import { createStructuredFingerprintMemo } from ${JSON.stringify(path.join(root, "extension/structured-fingerprint.ts"))};\n` + contents;
        contents = contents.replaceAll("binding.connection.retireForReplacement?.(", "await binding.connection.retireForReplacement?.(")
          .replaceAll("binding.connection.confirmReplacement?.(", "await binding.connection.confirmReplacement?.(")
          .replaceAll("binding.connection.discardSession?.(", "await binding.connection.discardSession?.(");
        contents = `import { drainCancelledTurn, isSteerAbort, steerMode } from ${JSON.stringify(path.join(root, "extension/turn-cancellation.ts"))};\n` + contents;
        contents = `import { claimContinuation } from ${JSON.stringify(path.join(root, "extension/continuation-claim.ts"))};\n` + contents;
        contents = `import { createHistoryFingerprintMemo } from ${JSON.stringify(path.join(root, "extension/history-fingerprint.ts"))};\nconst ompMessageFingerprintMemo = createHistoryFingerprintMemo();\n` + contents;
        contents = `import { ToolRelay, resolveRelayConfig, relayControlTool, projectedMcpName, TOOL_RELAY_CONTROL_NAME } from ${JSON.stringify(path.join(root, "extension/tool-relay.ts"))};\n` + contents;
        contents = `import { AcpFailure } from ${JSON.stringify(path.join(root, "extension/acp-errors.ts"))};\n` + contents;
        return { contents, loader: "ts" };
      });
      builder.onLoad({ filter: /\/src\/stream\/pi-events\.ts$/ }, async ({ path: file }) => {
        if (file !== path.join(upstream, "src/stream/pi-events.ts")) return;
        let contents = await fs.readFile(file, "utf8");
        const anchor = "\t\tthis.message.errorMessage = errorMessage(cause);";
        if (contents.split(anchor).length !== 2) throw new Error("Pinned upstream writer failure seam changed; review compatibility");
        contents = contents.replace(anchor, "\t\tthis.message.errorMessage = errorMessage(classifyAcpFailure(cause));");
        contents = `import { classifyAcpFailure } from ${JSON.stringify(path.join(root, "extension/acp-errors.ts"))};\n` + contents;
        return { contents, loader: "ts" };
      });
      builder.onLoad({ filter: /\/src\/mcp\/bridge\.ts$/ }, async ({ path: file }) => {
        if (file !== path.join(upstream, "src/mcp/bridge.ts")) return;
        let contents = await fs.readFile(file, "utf8");
        const serverAnchor = "\t\tthis.server.maxConnections = 8;";
        if (contents.split(serverAnchor).length !== 2) throw new Error("Pinned upstream MCP bridge server seam changed; review compatibility");
        contents = contents.replace(serverAnchor, `${serverAnchor}\n\t\tthis.server.keepAliveTimeout = 0;\n\t\tthis.server.requestTimeout = 0;\n\t\tthis.server.headersTimeout = 0;`);
        const anchor = "\treadonly fingerprint: string;\n\treadonly omissions: ToolOmission[] = [];\n\tprivate readonly token = crypto.randomUUID().replaceAll(\"-\", \"\");\n\tprivate readonly tools: BridgeTool[];";
        if (contents.split(anchor).length !== 2) throw new Error("Pinned upstream MCP bridge seam changed; review compatibility");
        contents = contents.replace(anchor, "\tfingerprint: string;\n\treadonly omissions: ToolOmission[] = [];\n\tprivate readonly token = crypto.randomUUID().replaceAll(\"-\", \"\");\n\tprivate tools: BridgeTool[];");
        const ctorAnchor = "\t\tthis.tools = projectTools(options.tools, this.omissions);\n\t\tthis.fingerprint = projectionFingerprint(this.tools, this.omissions);\n\t}";
        if (contents.split(ctorAnchor).length !== 2) throw new Error("Pinned upstream MCP bridge constructor seam changed; review compatibility");
        contents = contents.replace(ctorAnchor, `${ctorAnchor}\n\n\tupdateTools(tools: readonly Tool[]): void {\n\t\tthis.omissions.length = 0;\n\t\tthis.tools = projectTools(tools, this.omissions);\n\t\tthis.fingerprint = projectionFingerprint(this.tools, this.omissions);\n\t}`);
        const responsesAnchor = "\tprivate server: ReturnType<typeof createServer> | undefined;\n\tprivate url: string | undefined;";
        if (contents.split(responsesAnchor).length !== 2) throw new Error("Pinned upstream MCP bridge response seam changed; review compatibility");
        contents = contents.replace(responsesAnchor, responsesAnchor + "\n\tprivate readonly responses = new Set<ServerResponse>();");
        const closeAnchor = "\tasync close(): Promise<void> {\n\t\tconst server = this.server;\n\t\tthis.server = undefined;\n\t\tthis.url = undefined;\n\t\tif (!server) return;\n\t\tawait new Promise<void>((resolve) => server.close(() => resolve()));\n\t}";
        if (contents.split(closeAnchor).length !== 2) throw new Error("Pinned upstream MCP bridge close seam changed; review compatibility");
        contents = contents.replace(closeAnchor, "\tasync close(): Promise<void> {\n\t\tconst server = this.server;\n\t\tthis.server = undefined;\n\t\tthis.url = undefined;\n\t\tif (!server) return;\n\t\tconst closing = new Promise<void>((resolve) => server.close(() => resolve()));\n\t\tfor (const response of this.responses) response.destroy();\n\t\tthis.responses.clear();\n\t\tserver.closeAllConnections();\n\t\tawait closing;\n\t}");
        const handleAnchor = "\tprivate async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {\n\t\tif (request.url !== \"/mcp\" || request.method !== \"POST\") {";
        if (contents.split(handleAnchor).length !== 2) throw new Error("Pinned upstream MCP bridge handle seam changed; review compatibility");
        contents = contents.replace(handleAnchor, "\tprivate async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {\n\t\tthis.responses.add(response);\n\t\tresponse.once(\"close\", () => this.responses.delete(response));\n\t\tif (request.url !== \"/mcp\" || request.method !== \"POST\") {");
        return { contents, loader: "ts" };
      });
      builder.onLoad({ filter: /\/src\/acp\/connection\.ts$/ }, async ({ path: file }) => {
        if (file !== path.join(upstream, "src/acp/connection.ts")) return;
        let contents = await fs.readFile(file, "utf8");
        const anchor = "if (aborting) finish(() => reject(abortError()));";
        if (contents.split(anchor).length !== 2) throw new Error("Pinned upstream prompt cancellation seam changed; review compatibility");
        contents = contents.replace(anchor,
          "if (aborting && this.process.alive && ['cancelled', 'end_turn'].includes(value.stopReason)) finish(() => resolve(value));\n\t\t\t\t\telse if (aborting) finish(() => reject(abortError()));");
        const commandImportAnchor = "\ttype AuthenticateRequest,\n\ttype InitializeResponse,";
        if (contents.split(commandImportAnchor).length !== 2) throw new Error("Pinned ACP command import seam changed; review compatibility");
        contents = contents.replace(commandImportAnchor, "\ttype AuthenticateRequest,\n\ttype AvailableCommand,\n\ttype InitializeResponse,");
        const initialCommandsAnchor = "\t\tconst state = { ...this.sessions.get(sessionId), ...decodeSessionState(response) };\n\t\tthis.sessions.set(sessionId, state);\n\t\treturn state;";
        if (contents.split(initialCommandsAnchor).length !== 2) throw new Error("Pinned initial available-commands seam changed; review compatibility");
        contents = contents.replace(initialCommandsAnchor,
          "\t\tconst commands = (response as { availableCommands?: AvailableCommand[] | null }).availableCommands;\n" +
          "\t\tconst state = { ...this.sessions.get(sessionId), ...decodeSessionState(response), ...(commands === undefined ? {} : { availableCommands: commands }) };\n" +
          "\t\tthis.sessions.set(sessionId, state);\n\t\treturn state;");
        const detailAnchor = "const detail = (data as { details?: unknown }).details;";
        if (contents.split(detailAnchor).length !== 2) throw new Error("Pinned upstream structured error detail seam changed; review compatibility");
        contents = contents.replace(detailAnchor,
          "const record = data as { details?: unknown; message?: unknown };\n\tconst detail = record.details ?? record.message;");
        const capabilitiesAnchor = "\t\t\t\tclientCapabilities: {\n\t\t\t\t\tfs: { readTextFile: false, writeTextFile: false },\n\t\t\t\t\tterminal: false,\n\t\t\t\t},";
        if (contents.split(capabilitiesAnchor).length !== 2) throw new Error("Pinned ACP client capability seam changed; review compatibility");
        contents = contents.replace(capabilitiesAnchor,
          "\t\t\t\tclientCapabilities: {\n\t\t\t\t\tfs: { readTextFile: false, writeTextFile: false },\n\t\t\t\t\tterminal: false,\n\t\t\t\t\tsession: { compaction: {} },\n\t\t\t\t},");
        return { contents, loader: "ts" };
      });
      builder.onLoad({ filter: /\/(?:process|runtime-manifest)\.ts$/ }, async ({ path: file }) => {
        const relative = path.relative(upstream, file).split(path.sep).join("/");
        return {
          contents: (await fs.readFile(file, "utf8")).replaceAll(
            "import.meta.url",
            `__ompAssetURL(${JSON.stringify("pi-antigravity-acp-provider/" + relative)})`,
          ),
          loader: "ts",
        };
      });
    },
  }],
  outfile: path.join(root, "extension/runtime.mjs"),
  logLevel: "info",
});

// The npm tarball ships a bundle. Include the full notices of packages whose
// code is bundled, in addition to their individually installed npm licenses.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes("node_modules")) continue;
  let directory = path.dirname(path.resolve(root, input));
  while (directory !== path.dirname(directory)) {
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
      if (metadata.name && metadata.version) {
        packages.set(directory, metadata);
        break;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    directory = path.dirname(directory);
  }
}
const notices = [];
for (const [directory, metadata] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  const names = (await fs.readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(name));
  const texts = [];
  for (const name of names) {
    if ((await fs.stat(path.join(directory, name))).isFile()) {
      texts.push(`${name}\n${await fs.readFile(path.join(directory, name), "utf8")}`);
    }
  }
  if (!texts.length && metadata.name === "@earendil-works/pi-ai" && metadata.version === "1.3.0") {
    texts.push(await fs.readFile(path.join(root, "licenses/pi-ai-1.3.0.txt"), "utf8"));
  }
  if (!texts.length) {
    for (const name of (await fs.readdir(directory)).filter(name => /^readme(?:\..*)?$/i.test(name))) {
      const readme = await fs.readFile(path.join(directory, name), "utf8");
      const license = readme.match(/^#{1,6}\s+License\s*\r?\n([\s\S]*)/im)?.[1];
      if (license?.includes("Copyright") && license.includes("Permission is hereby granted")) {
        texts.push(`${name} license section\n${license}`);
      }
    }
  }
  if (!texts.length) throw new Error(`Missing bundled license notice for ${metadata.name}`);
  notices.push(`${metadata.name}@${metadata.version}\nLicense: ${metadata.license ?? "see notice"}\n\n${texts.join("\n\n")}`);
}
await fs.writeFile(path.join(root, "THIRD_PARTY_LICENSES.txt"), notices.join("\n\n============================================================\n\n") + "\n");
