import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstream = path.dirname(require.resolve("pi-antigravity-acp-provider/package.json"));
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
      builder.onResolve({ filter: /^\.\/acp\/session-store\.js$/ }, ({ importer }) => {
        if (importer === path.join(upstream, "src/runtime.ts")) return { path: path.join(root, "extension/session-store.ts") };
      });
      builder.onLoad({ filter: /\/src\/runtime\.ts$/ }, async ({ path: file }) => {
        if (file !== path.join(upstream, "src/runtime.ts")) return;
        const patches = [
          {
            name: "validated message fingerprint memo",
            anchor: 'return createHash("sha256").update(canonicalJson(value)).digest("hex");',
            replacement: 'return ompMessageFingerprintMemo(message, value, () => createHash("sha256").update(canonicalJson(value)).digest("hex"));',
          },
          {
            name: "context",
            anchor: "buildPromptParts(context, fresh, unseenStart)",
            replacement: "buildPromptParts(context, fresh, unseenStart, { contextWindow: model.contextWindow, maxTokens: model.maxTokens, policy: model.ompContextPolicy })",
          },
          {
            name: "new request supersedes continuation",
            anchor: "\t\t// A permission tool result resumes the still-running ACP prompt rather than",
            replacement: [
              "\t\t// A new/edited user request is not a tool-result continuation of the",
              "\t\t// previous ACP prompt. Never let old pending results swallow it.",
              "\t\tif ((binding.turnCompletion || binding.permission || binding.pendingTools.size > 0) &&",
              "\t\t\t(context.messages.findLastIndex(message => message.role === 'user') >= binding.pendingContextCount ||",
              "\t\t\t messagesFingerprint(context.messages.slice(0, binding.pendingContextCount)) !== binding.pendingContextFingerprint)) {",
              "\t\t\tconst prefixMatches = context.messages.length >= binding.pendingContextCount &&",
              "\t\t\t\tmessagesFingerprint(context.messages.slice(0, binding.pendingContextCount)) === binding.pendingContextFingerprint;",
              "\t\t\tconst drained = prefixMatches && await drainCancelledTurn(binding, () => abortTurn(binding), options.signal);",
              "\t\t\tif (!drained || !binding.connection.process.alive || binding.needsReconstruction ||",
              "\t\t\t\t!['cancelled', 'end_turn'].includes(binding.ompTerminalStopReason)) {",
              "\t\t\t\tawait this.invalidateBinding(binding);",
              "\t\t\t}",
              "\t\t\tbinding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);",
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
              "\t\t\t\tif (binding.connection.process.alive && !binding.ompInvalidated && !binding.needsReconstruction &&",
              "\t\t\t\t\t['cancelled', 'end_turn'].includes(binding.ompTerminalStopReason)) {",
              "\t\t\t\t\tbinding.messageCount = binding.pendingContextCount;",
              "\t\t\t\t\tbinding.historyFingerprint = binding.pendingContextFingerprint;",
              "\t\t\t\t\tbinding.expectedAssistantFingerprint = messageFingerprint((binding.writer ?? writer).message);",
              "\t\t\t\t\tbinding.ompCancelledCheckpoint = true;",
              "\t\t\t\t\tbinding.ompCancelledHadOutput = (binding.writer ?? writer).message.content.length > 0;",
              "\t\t\t\t\tbinding.ompExpectedAssistantHasOutput = binding.ompCancelledHadOutput;",
              "\t\t\t\t\tbinding.ompInFlight = false;",
              "\t\t\t\t\ttry { this.persistBinding(binding); } catch (checkpointError) { await this.invalidateBinding(binding); throw checkpointError; }",
              "\t\t\t\t} else await this.invalidateBinding(binding);",
              "\t\t\t} else if (ompDispatched) await this.invalidateBinding(binding);",
              "\t\t\telse binding.ompInFlight = false;",
            ].join("\n"),
          },
          {
            name: "reset cancellation acknowledgement per prompt",
            anchor: "binding.instructionsFingerprint = instructionFingerprint(context);",
            replacement: "binding.ompTerminalStopReason = undefined;\n\t\t\t" + "binding.instructionsFingerprint = instructionFingerprint(context);",
          },
          {
            name: "record official terminal reason before abort handling",
            anchor: "if (binding.abortRequested) throw abortError();",
            replacement: "if (binding.ompInvalidated) throw new AntigravityAcpError('protocol', 'ACP session ownership was lost');\n\t\t\tbinding.ompTerminalStopReason = response.stopReason;\n\t\t\tif (binding.abortRequested) throw abortError();",
          },
          {
            name: "generated assistant boundary must match retained OMP history",
            anchor: "binding.needsReconstruction || binding.mode !== this.permissionMode ||",
            replacement: [
              "binding.needsReconstruction ||",
              "\t\t\t\t(binding.expectedAssistantFingerprint && context.messages[binding.messageCount]?.role === 'assistant' &&",
              "\t\t\t\t\tmessageFingerprint(context.messages[binding.messageCount]) !== binding.expectedAssistantFingerprint) ||",
              "\t\t\t\t((binding.ompExpectedAssistantHasOutput || (binding.ompCancelledCheckpoint && binding.ompCancelledHadOutput)) &&",
              "\t\t\t\t\tcontext.messages[binding.messageCount]?.role !== 'assistant') || binding.mode !== this.permissionMode ||",
            ].join("\n"),
          },
          {
            name: "persist cancellation checkpoint flags",
            anchor: "acpModelId: binding.modelId,",
            replacement: "acpModelId: binding.modelId,\n\t\t\tompCancelledCheckpoint: binding.ompCancelledCheckpoint === true,\n\t\t\tompCancelledHadOutput: binding.ompCancelledHadOutput === true,",
          },
          {
            name: "restore cancellation checkpoint flags",
            anchor: "messageCount: restored && saved ? saved.messageCount : 0,",
            replacement: "messageCount: restored && saved ? saved.messageCount : 0,\n\t\t\t\tompCancelledCheckpoint: restored && saved?.ompCancelledCheckpoint === true,\n\t\t\t\tompCancelledHadOutput: restored && saved?.ompCancelledHadOutput === true,",
          },
          {
            name: "connection retirement",
            anchor: "if (!persistent) await this.dropBinding(key, binding);",
            replacement: "if (!persistent || !binding.connection.process.alive) await this.dropBinding(key, binding);",
          },
          {
            name: "cleanup retire",
            anchor: "const current = this.bindings.get(key);\n\t\tif (current && (await current) === binding",
            replacement: "if (removeSaved) binding.connection.retireForReplacement?.(key, binding.session.sessionId);\n\t\tconst current = this.bindings.get(key);\n\t\tif (current && (await current) === binding",
          },
          {
            name: "cleanup confirm",
            anchor: "this.persistBinding(binding);\n\t\t\tswitch (response.stopReason)",
            replacement: "if (response.stopReason !== 'cancelled') binding.ompCancelledCheckpoint = false;\n\t\t\tthis.persistBinding(binding);\n\t\t\tif (response.stopReason === 'end_turn') { binding.connection.confirmReplacement?.(key, binding.session.sessionId); if (!persistent) binding.connection.discardSession?.(binding.session.sessionId); }\n\t\t\tswitch (response.stopReason)",
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
          ["private async closeBindings(): Promise<void> {", "private async closeBindings(): Promise<void> {\n const closingTurns = [...this.resolvedBindings].flatMap(binding => binding.turnCompletion ? [binding.turnCompletion] : []);"],
          ["\t\tthis.persistBinding(createdBinding);", "\t\tthis.persistBinding(createdBinding);\n\t\tthis.assertEpoch(epoch);"],
          ["if (removeSaved && binding.piSessionId) this.sessionStore?.remove(binding.piSessionId);\n\t\t\tthis.bindings.delete(key);", "this.bindings.delete(key);\n\t\t\tif (removeSaved && binding.piSessionId) this.sessionStore?.remove(binding.piSessionId);"],
        ];
        for (const [anchor, replacement] of asyncPatches) {
          if (contents.split(anchor).length !== 2) throw new Error(`Pinned async store seam changed: ${anchor}`);
          contents = contents.replace(anchor, replacement);
        }
        for (const [anchor, replacement, count] of [
          ["this.persistBinding(", "await this.persistBinding(", 3],
          ["this.noteContinuationInstructions(binding, context);", "const continuationTurn = binding.turnCompletion; await this.noteContinuationInstructions(binding, context); if (!continuationTurn || binding.turnCompletion !== continuationTurn || binding.abortRequested || options.signal?.aborted || !binding.connection.process.alive) throw abortError();", 2],
          ["this.sessionStore?.", "await this.sessionStore?.", 8],
        ]) {
          if (contents.split(anchor).length !== count + 1) throw new Error(`Pinned store call sites changed: ${anchor}`);
          contents = contents.replaceAll(anchor, replacement);
        }
        // Continuity transactions are adapter-owned. Keep explicit pinned seams
        // so an upstream update cannot silently bypass the write-ahead marker.
        const continuityPatches = [
          ['interface Binding {', 'interface Binding {\n ompInFlight: boolean; ompInvalidated: boolean; ompDropPromise?: Promise<void>; ompExpectedAssistantHasOutput: boolean; ompReleaseLease?: () => Promise<void>;'],
          ['let completeTurn: (() => void) | undefined;', 'let ompDispatched = false;\n\t\tlet completeTurn: (() => void) | undefined;'],
          ['if (existing) return existing;', `if (existing) {
            const value = await existing;
            if (!value.ompInvalidated) return value;
            await value.ompDropPromise;
            if (this.bindings.get(key) === existing) this.bindings.delete(key);
            return this.getBinding(key, model, acpModelId, apiKey, writer, tools, signal);
          }`],
          ['if (value === createdBinding && this.bindings.get(key) === current) this.bindings.delete(key);',
            'if (value === createdBinding && this.bindings.get(key) === current && !createdBinding.ompInvalidated) this.bindings.delete(key);'],
          ['const saved = piSessionId ? await this.sessionStore?.get(piSessionId) : undefined;', `let saved = piSessionId ? await this.sessionStore?.get(piSessionId) : undefined;
            if (saved && (saved.ompCheckpointVersion !== 1 || saved.ompInFlight !== false)) {
              await connection.retireForReplacement?.(key, saved.acpSessionId);
              await this.ompRemoveSaved(saved.piSessionId, saved.acpSessionId);
              saved = undefined;
            }`],
          ['const createdBinding: Binding = {', `const createdBinding: Binding = {
            ompInFlight: false, ompInvalidated: false,
            ompReleaseLease: releaseLease,
            ompExpectedAssistantHasOutput: restored && saved?.ompExpectedAssistantHasOutput === true,`],
          ['const response = await binding.connection.prompt(', `if (options.signal?.aborted) throw abortError();
            binding.ompInFlight = true;
            await this.persistBinding(binding);
            this.assertEpoch(epoch);
            if (binding.ompInvalidated || !binding.connection.process.alive) throw new AntigravityAcpError('protocol', 'ACP session closed before prompt dispatch');
            if (options.signal?.aborted) throw abortError();
            ompDispatched = true;
            const response = await binding.connection.prompt(`],
          ['binding.expectedAssistantFingerprint = messageFingerprint(activeWriter.message);', `binding.expectedAssistantFingerprint = messageFingerprint(activeWriter.message.content.length
              ? activeWriter.message : { ...activeWriter.message, content: [{ type: 'text', text: '' }] });
            binding.ompExpectedAssistantHasOutput = activeWriter.message.content.some(block => block.type !== 'text' || block.text.length > 0);
            binding.ompInFlight = false;`],
          ['if (!binding.piSessionId) return;', 'if (!binding.piSessionId || binding.ompInvalidated) return;'],
          ['acpModelId: binding.modelId,', 'acpModelId: binding.modelId,\n ompCheckpointVersion: 1, ompInFlight: binding.ompInFlight === true, ompExpectedAssistantHasOutput: binding.ompExpectedAssistantHasOutput === true,'],
          ['if (binding.needsReconstruction) { await this.sessionStore?.remove(binding.piSessionId); return; }',
            'if (binding.needsReconstruction) { await this.ompRemoveSaved(binding.piSessionId, binding.session.sessionId); return; }'],
        ];
        for (const [anchor, replacement] of continuityPatches) {
          if (contents.split(anchor).length !== 2) throw new Error(`Pinned continuity seam changed: ${anchor}`);
          contents = contents.replace(anchor, replacement);
        }
        const leasePatches = [
          ['const connection = this.createConnection({\n\t\t\tcwd,', 'let leaseLost = false;\n\t\tlet releaseLease: (() => Promise<void>) | undefined;\n\t\tconst connection = this.createConnection({\n\t\t\tcwd,'],
          ['onPermission: (request) => this.requestPermission(binding, request),\n\t\t\t},\n\t\t});\n\t\ttry {\n\t\t\tconst initialize = await connection.initialize();', `onPermission: (request) => this.requestPermission(binding, request),
            },
          });
          try {
            if (key.startsWith('sid:') && typeof this.sessionStore?.acquireSessionLease === 'function') {
              const releaseOwnedLease = await this.sessionStore.acquireSessionLease(key.slice(4), () => { leaseLost = true; if (binding) binding.ompInvalidated = true; void connection.close().catch(() => {}); });
              releaseLease = async () => {
                if (connection.process.alive) {
                  void connection.process.exited.then(releaseOwnedLease).catch(() => {});
                  return;
                }
                await releaseOwnedLease();
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
            if (leaseLost) throw new AntigravityAcpError('protocol', 'ACP session ownership was lost during initialization');
\t\t\tawait this.persistBinding(createdBinding);`],
          ['await Promise.allSettled([connection.close(), bridge?.close() ?? Promise.resolve()]);\n\t\t\tthrow error;', `await Promise.allSettled([connection.close(), bridge?.close() ?? Promise.resolve()]);
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
          .replaceAll(claimEnd, '}, () => this.invalidateBinding(binding));\n\t\t\t\tawait this.awaitContinuation(binding, options.signal);\n\t\t\t\treturn;');
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
            if (removeSaved && binding.piSessionId) await this.ompRemoveSaved(binding.piSessionId, binding.session.sessionId);
            return;
          }
          const dropping = (async () => {
            const current = this.bindings.get(key);
            this.resolvedBindings.delete(binding);
            cancelPermission(binding);
            cancelPiTools(binding, 'Antigravity session closed before Pi returned the tool result');
            const closing = Promise.allSettled([binding.connection.close(), binding.bridge?.close() ?? Promise.resolve()]);
            try {
              if (removeSaved) {
                binding.connection.retireForReplacement?.(key, binding.session.sessionId);
                if (binding.piSessionId) await this.ompRemoveSaved(binding.piSessionId, binding.session.sessionId);
              }
            } finally {
              await closing;
              await binding.ompReleaseLease?.();
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
        contents = `import { createStructuredFingerprintMemo } from ${JSON.stringify(path.join(root, "extension/structured-fingerprint.ts"))};\n` + contents;
        contents = contents.replaceAll("binding.connection.retireForReplacement?.(", "await binding.connection.retireForReplacement?.(")
          .replaceAll("binding.connection.confirmReplacement?.(", "await binding.connection.confirmReplacement?.(")
          .replaceAll("binding.connection.discardSession?.(", "await binding.connection.discardSession?.(");
        contents = `import { drainCancelledTurn } from ${JSON.stringify(path.join(root, "extension/turn-cancellation.ts"))};\n` + contents;
        contents = `import { claimContinuation } from ${JSON.stringify(path.join(root, "extension/continuation-claim.ts"))};\n` + contents;
        contents = `import { createHistoryFingerprintMemo } from ${JSON.stringify(path.join(root, "extension/history-fingerprint.ts"))};\nconst ompMessageFingerprintMemo = createHistoryFingerprintMemo();\n` + contents;
        return { contents, loader: "ts" };
      });
      builder.onLoad({ filter: /\/src\/acp\/connection\.ts$/ }, async ({ path: file }) => {
        if (file !== path.join(upstream, "src/acp/connection.ts")) return;
        const source = await fs.readFile(file, "utf8");
        const anchor = "if (aborting) finish(() => reject(abortError()));";
        if (source.split(anchor).length !== 2) throw new Error("Pinned upstream prompt cancellation seam changed; review compatibility");
        return { contents: source.replace(anchor,
          "if (aborting && this.process.alive && ['cancelled', 'end_turn'].includes(value.stopReason)) finish(() => resolve(value));\n\t\t\t\t\telse if (aborting) finish(() => reject(abortError()));"), loader: "ts" };
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
