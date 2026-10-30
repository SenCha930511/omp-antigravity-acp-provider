# Changelog


## Unreleased

- Reuse the warm ACP session when steering on servers without `session/cancel` (verified `agy_acp_server` 1.4.3 returns `-32601`): hold the caller's abort, keep the transport open so the superseded turn ends naturally, freeze message/thought/tool/plan updates so the retained partial output matches the checkpoint fingerprint, and send the new request as a warm delta instead of a full cold replay that could trip the 188,000-byte per-step guard and force OMP compaction. The grace is activity-aware — long thinking or tool loops keep extending it — and only a silent gap beyond `OMP_ACP_STEER_GRACE_MS` (default 60000 ms, `0` restores the old rebuild) or the absolute `OMP_ACP_STEER_GRACE_MAX_MS` cap (default 300000 ms, `0` uncapped) falls back to cold reconstruction; the vendored progress watchdog stays the outer safety net.

- Let `balanced` cleanup reclaim a still-mapped conversation once its last activity exceeds `idleDays`, after proving unique ownership and removing the mapping first; the next turn rebuilds from OMP history. `conservative` and `timeout` keep mapped sessions, and live leases or ambiguous mappings still preserve them.
- Keep cleanup working when one OMP journal is unreadable: an empty or truncated `.jsonl` now marks the relocation scan incomplete instead of aborting it for every session, and an incomplete scan can never prove a missing source was deleted.
- Always release a session's one-shot registration when its runtime teardown fails, instead of skipping the unbind because one closing promise rejected.
- Strip every advertised effort suffix (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) before API cost lookup, from the same shared list the catalog uses, so `-max` and `-minimal` variants are no longer unpriced.

## 0.1.28 — 2026-10-30

- Make the macOS keychain path asynchronous with explicit outcomes: present, confirmed absent only for the not-found exit with matching stderr, and rejection with fixed credential-free messages for every other failure, so timeouts or permission errors can no longer be reported as signed out or as successful credential removal.
- Refuse a fresh Google login when durable keychain removal cannot be confirmed, instead of silently reusing a possibly retained previous-account credential.
- Re-check the OMP credential marker immediately before the followed logout deletes the keychain entry, and refresh the watcher state inside the command-logout guard, so a quick re-login after `/antigravity-acp logout` cannot have its new keychain credential deleted by a stale deferred logout.
- Surface followed-logout failures as one fixed error notice instead of unhandled promise rejections, including on the busy-retry path.
- Retry transient `ELOCKED` cleanup-registry contention with a bounded 5-second budget on the resume/load path only, keeping warm native session restoration under short lock races; every other path still fails fast with the original error identity.
- Compute the pending-prefix fingerprint once per dispatch in the supersedes-continuation path (previously twice) and index source-tracking mappings in one scan inside the cleanup transaction, with behavior-equivalence and call-count regressions.

## 0.1.27 — 2026-10-30

- Add an optional balanced cleanup preset with orphan retention, minimum recovery windows, soft budgets and reclaimed-byte reporting; preserve the existing default policy and OMP history.
- Retire saved owned one-shot mappings only on OMP's explicit final release, after runtime teardown, including after idle eviction; preserve newer/shared mappings and gate reused routing IDs through cleanup.
- Honor OMP provider close/release hooks across fresh routing IDs, side requests and adapter reloads; wait for teardown and block stale deferred dispatch.
- Project OMP tool declarations before hashing so mutable host state cannot trigger history replay; preserve array system-prompt paragraphs.
- Prevent concurrent identical transcript snapshots from dispatching twice while allowing identical text in a later user turn.
- Rebuild ambiguous session mappings, clear previous-account mappings on fresh login, and rebuild when cwd or a parked prompt's model changes.
- Add built-runtime transition regressions and an optional offline integration using real OMP RPC and process restart. See [session transition audit](docs/session-transition-audit-2026-10-30.md).
- Preserve warm idle runtimes when acquiring active work, reduce LRU temporary allocations, and await teardown across concurrent global shutdowns.
- Validate complete checkpoint mappings before cleanup and release obsolete in-memory activity entries.
- Keep catalog projections, settings and lookups consistent; restore source limits when overrides are removed and publish refreshes only after successful persistence. Reuse fallback catalogs when the cache is absent.
- Reject oversized history during serialization, avoid argument-spread stack overflows, and count escaped resource text in wire budgets without copying image base64.
- Reject overflowing idle timers, surplus command arguments and inherited context-setting keys; safely handle model names that match object methods.
- Add offline regressions and a before/after resource benchmark with 256 equivalent prompt fixtures. See [the audit](docs/resource-code-audit-2026-10-30.md) for measurements and limits.
- Cancel any pending followed logout when a fresh Google login succeeds and restore the config apiKey fallback, so command-driven re-login cannot be undone by a stale deferred logout; make login and command logout remove the macOS keychain credential durably.
- Close five conservative-mode session leaks: discard discovery/login/verify sessions, retire replaced, unrestorable and mode-mismatched saved mappings, and release pre-acquired cleanup leases when session restore fails, while keeping usage baselines while prompts are active.
- Wait for in-flight teardown of previously visited sessions in the same scope during `session_shutdown`, so a synchronous OMP close cannot outlive the final registry flush.
- Persist permission and native-tools settings before mutating live state or closing runtimes, so a failed disk write cannot desynchronize runtime and on-disk configuration.
- Skip background cleanup scans when a turn confirmed nothing for replacement, avoiding a full directory walk after every ordinary response.
- Publish a slimmer npm tarball (37 files instead of 75) by excluding vendored sources and build scripts from the package.

## 0.1.26 — 2026-10-29

- Wait for the retiring ACP process to exit during binding drop before releasing the session lease, preventing lock contention (`This OMP session is already open in another ACP runtime`) during history compaction or reconstruction.
- Memoize lease releases to ensure idempotent cleanup.
- Add `closeIdle` runtime cleanup and protect OAuth login bindings with session lease.
- Add offline regression tests for compaction lease handoff and idle runtime cleanup.

## 0.1.25 — 2026-10-29

- Vendor `pi-antigravity-acp-provider 0.1.15` source under `extension/vendor/pi-antigravity-acp-provider` (MIT) instead of npm dependency. All imports, build and test scripts now point to local vendor for direct modification. Updated docs and added required runtime deps (`@agentclientprotocol/sdk`, `@modelcontextprotocol/sdk`, `unzipper`, `zod`).

## 0.1.24 — 2026-10-29
- Keep session ownership if ACP shutdown times out and release it only after the process actually exits. Add an offline regression for the timed-out shutdown and subsequent handoff.

## 0.1.23 — 2026-10-29

- Hold a cross-process session lease through restoration and warm runtime lifetime, preventing simultaneous ownership of a single OMP session. Losing the lease closes its ACP connection; restart all older OMP processes to participate in coordination.
- Use OMP's active agent directory for adapter state, so named profiles and custom agent directories do not share mappings or settings. Existing default state remains in place; other profiles reconstruct mappings from their OMP history on first use and use their own settings.
- Refuse to read or overwrite a registry containing malformed or unsupported individual records, preserving the original file for recovery.
- Add offline regressions for separate-process lease exclusion, runtime handoff and lost ownership, profile paths, and unsupported records.

## 0.1.22 — 2026-10-29

- Fix a regression in 0.1.21 that held continuation ownership until the entire ACP prompt finished, rejecting normal later tool/permission batches as already in progress. Release ownership after attaching the writer and delivering the current batch, while retaining protection against overlapping duplicate callers.
- Add built-runtime regressions for consecutive tool batches, consecutive permissions and mixed tool/permission sequences within one prompt, including immediate continuation without an event-loop delay.

## 0.1.21 — 2026-10-29

- Reject oversized ACP step text before inference so cold replay after plan refinement cannot silently lose the newest request or recent decisions. Keep the server step limit independent of model-window, wire and image budgets, and report context overflow for OMP's existing compaction recovery.
- Persist a versioned in-flight marker before prompt dispatch and clear it only with a successful terminal checkpoint. Rebuild uncertain/legacy mappings, retire unknown prompt failures, preserve known-good sessions on local preflight failures, and prevent late dispatch after shutdown.
- Claim tool and permission continuation ownership before asynchronous work so duplicate callers receive an explicit error instead of orphaning the first response stream.
- Invalidate incomplete tool/permission-result fallbacks, conditionally remove old mappings, and prevent retiring turns from repersisting them while teardown completes.
- Reconstruct when a retained completed assistant answer changes or disappears; preserve normal warm reuse and normalize empty completed-answer fingerprints.
- Add built-runtime plan-refinement coverage and an optional offline integration with OMP's adaptive summary windows.

## 0.1.20 — 2026-10-21

- Reconcile verified deleted OMP journals with owned ACP sessions: preserve live/moved/unknown sources, confirm absence across checks, remove mappings conditionally and honor cleanup off/conservative/timeout modes.
- Validate the outer tool-projection cache against tool values, including in-place name/schema/array edits, before reusing bridge schemas and prompt guidance.
- Protect saved mappings and live leases during asynchronous session cleanup; add soft count/byte budgets, orphan grace, bounded background batches, lifecycle retries and status accounting. Conservative mode remains the default.
- Limit idle runtimes with an LRU cap (default two), deduplicate concurrent catalog discovery/refresh and remove stale catalog entries.
- Add opt-in timing diagnostics with 128 in-memory samples, disabled by default and without conversation content.
- Bundle required upstream code and supervisor assets into a standalone package with no production dependencies; verify clean installation and offline OMP loading. The separately downloaded Google runtime is unchanged.
- Cache value-validated system/tool fingerprints across regenerated containers, with per-runtime memory limits and teardown clearing; preserve exact digests and schema-mutation detection.
- Replace blocking session-registry writes with asynchronous locked merge/atomic-rename transactions. Await cancellation checkpoints, initialization and active writes at lifecycle boundaries; prevent mode-change/queued-request deadlocks.

- Reuse large-message history fingerprints only after validating independent value snapshots, preserving SHA-256 compatibility and post-await continuity checks. Small/complex/unsupported messages retain the original algorithm; weak keys release discarded history.
- Add built-runtime digest compatibility, mutable-history cancellation regressions and offline timing/memory probes.

## 0.1.19 — 2026-10-21

- Prevent new or edited user requests from being swallowed by a pending tool/permission continuation after interruption.
- Reuse ACP sessions after acknowledged cancellation when accepted history and partial output match; queue new requests behind cancellation and rebuild only on uncertain/edited state or forced close.
- Persist cancellation checkpoints across idle restoration and skip supplemental usage queries on cancelled turns.
- Separate replayed history from the current request explicitly and label cold tool handoffs as work already in progress.
- Restore missing context-setting imports after the command refactor and include command/continuity regressions in the required checks.


## 0.1.18 — 2026-10-21

- Removed the macOS keychain secret read behind the Google account email display. When Antigravity stores its OAuth token in the keychain (no token file), every `/antigravity-acp account` or login confirmation read the keychain item's secret via `security find-generic-password -w`, which pops the macOS keychain password dialog each time because the security CLI is not in the item's ACL. The adapter never reads that secret now: the email still appears when the ACP token file exists, and `/antigravity-acp account` reports `signed in (token in macOS keychain; email not read)` instead, using prompt-free attribute lookups only.

## 0.1.17 — 2026-10-21

- Lazy command handling: `/antigravity-acp usage`, `refresh`, `account` and permission validation no longer instantiate an idle AntigravityRuntime; `account` reports the saved-session count and requested permission mode from stored state, and logout completes even when the runtime pool is empty (session store and credentials are cleared directly instead of creating a runtime just to log it out).
- Strict command validation: unknown subcommands and stray arguments (`/antigravity-acp unknown`, `permissions invalid`, `refresh extra`, `tools extra`, `status extra`) now fail with explicit usage errors before any runtime work instead of silently falling through to the status display.
- Hot-path and I/O savings: `buildPromptParts` reuses fully resolved context policies on the runtime hot path and stops shallow-copying message blocks or merging image arrays; `SessionCleanup` caches its policy by mtime+size and verifies the cleanup root once per collect; `CatalogStore` deduplicates `fetchDynamicModels` by cache-file stat and settings identity; the tool projection cache also hits when the host passes an equal-but-new tool array; `TierConnection` usage captures are keyed per session so concurrent `/usage` queries cannot clobber each other.
- Shared helpers: one logout summary formatter, one `saveToolPolicy` writer, and one `splitLegacyEffort` parser replace their duplicated copies.
- TypeScript rule compliance: adapter sources no longer use `ReturnType<typeof …>`, the `new Promise` constructor or `as unknown as RuntimeBundleView` casts; the runtime pool is typed directly as `SessionRuntimePool<RuntimeBundleView>`.
- Faster test builds: `scripts/test.mjs` externalizes node_modules packages and enables code splitting, keeping the pinned upstream TypeScript bundled (Node cannot type-strip TypeScript inside node_modules). `extension/runtime.mjs` deliberately keeps its full bundle because OMP's marketplace launcher cannot resolve bare package imports in its dynamic-import subgraph.
- Adds `test/commands.test.ts` covering no-runtime reporting and usage-error validation for the command handler.

## 0.1.16 — 2026-10-21

- Fix the 0.1.15 marketplace regression where the adapter failed to load with `Cannot find package '@agentclientprotocol/sdk'`: the refactor had `catalog-store.ts` import `TierConnection` from the unbundled `tier-connection.ts` source, pulling the pinned upstream sources into OMP's launcher import path where OMP's extension loader cannot resolve bare package imports. `TierConnection` is imported from the prebuilt `extension/runtime.mjs` bundle again, keeping the load-time graph bundle-only.
- Add a load-time graph test (`npm run test:graph`, part of `npm run check`) that fails if any module reachable from `extension/index.ts` bare-imports a package, so upstream-dependent sources can never re-enter the launcher path unnoticed.

## 0.1.15 — 2026-10-21

- Internal hardening refactor with no behavior change: auth watching, logout following, catalog management, and command handling moved into focused modules (`auth-sync.ts`, `catalog-store.ts`, `commands.ts`), atomic JSON writes and file-error handling deduplicated into `fs-atomic.ts`, and `any` types replaced with explicit interfaces across the adapter.
- Fix a cross-session usage-capture leak: supplemental usage queries now scope captured agent message chunks to the session that requested them, and a finished query no longer clears a newer concurrent capture.
- Throttle session-cleanup registry touches to at most one disk write per minute per session, flushing pending timestamps on the next registry transaction or cleanup collect.
- Keep the upstream build patches byte-identical while making them data-driven, and estimate transfer tokens from UTF-8 byte counts instead of a per-character scan (identical results for ASCII and CJK text).

## 0.1.14 — 2026-10-21

- Stop OMP's `/logout` from reporting `antigravity-acp is still authenticated via provider config (fallback)`: when the marker credential is removed, the adapter synchronously unregisters and re-registers the provider without the non-secret config apiKey, so OMP finds no remaining auth source and the catalog correctly hides until the next `/login`.
- Keep the config fallback for fresh profiles that never stored a marker, and restore it whenever a marker is stored again, so first-run model listing and `/login` continue to work as before.

## 0.1.13 — 2026-10-21

- Show the signed-in Google account: `/antigravity-acp account` extracts the email claim from the ACP server's stored id_token (token file first, then the ACP keychain item), logins record it on OMP's marker credential so OMP's account list can label it, and login confirmations name the account.
- Only the ACP-owned keychain item is ever read; the agy CLI's separate item stays untouched, and token bytes are never logged or persisted.

## 0.1.12 — 2026-10-21

- Always start a fresh Google sign-in for OMP `/login` and `/antigravity-acp login`: stored credentials and this process's old-account servers are dropped first, so a new server process cannot silently reuse the saved login and keep the previous account.
- Remove the macOS keychain entry durably at logout: wait for this adapter's ACP server processes to fully exit, then verify the deletion, retrying when a dying server flushes its token back.
- Report logout results in one line; `/antigravity-acp account` keeps the details.
- Display `/antigravity-acp account` in the upstream provider's status wording (Authentication, credential-storage preflight, permission mode, active bindings) plus OMP-specific marker lines, replacing the JSON dump.

## 0.1.11 — 2026-10-21

- Follow OMP's `/logout`: when the stored marker record is removed, automatically finish the Antigravity-side logout (close this process's ACP runtimes, clear saved sessions, delete the local token file and settings auth choice, remove the macOS keychain entry) and confirm with a notification.
- Never trigger that cleanup for automatic credential soft-disables, self-removal by `/antigravity-acp logout`, or a quick re-login after removal; defer it while Antigravity requests are active.
- Add `OMP_ACP_FOLLOW_LOGOUT=0` to keep OMP's `/logout` limited to removing the marker record.
- Extend the offline auth-command suite with credential-store watch scenarios.

## 0.1.10 — 2026-10-21

- Add `/antigravity-acp account` to inspect authentication state on both the OMP and Antigravity sides, including the macOS keychain entry and saved ACP session count.
- Add `/antigravity-acp login` to run the Antigravity Google authorization in a command dialog, and `/antigravity-acp logout` to clear Antigravity credentials, saved ACP sessions, the macOS keychain entry and OMP's marker record in one step; logout refuses to run while requests are active.
- Keep OMP `/login`/`/logout` semantics explicit: OMP removes only its non-secret marker record, while the adapter command performs the complete local logout.
- Add an offline auth-command regression suite with isolated `GEMINI_HOME`, stubbed keychain and stubbed OAuth flow.

## 0.1.9 — 2026-10-20

- Add persistent `off`, `conservative` (default) and `timeout` ACP session-cleanup modes with a configurable idle deadline.
- Delete only adapter-owned local session databases, SQLite sidecars, metadata and per-session brain artifacts; never adopt unidentified pre-existing sessions.
- Conservative cleanup waits for a successful replacement turn and release of all participating OMP/ACP process leases. Discovery sessions are explicitly disposable.
- Keep normal shutdown/idle restoration intact; add cross-process locking, path/symlink guards and failure-safe retries.
- Add filesystem, policy-command and built-runtime reconstruction regressions without Google inference.

## 0.1.8 — 2026-10-20

- Separate estimated token budgets from wire payload and image size limits; remove the erroneous context-window-to-byte clamp.
- Add persistent default/per-model context settings and `/antigravity-acp context` inspection/update commands.
- Add `/antigravity-acp usage auto|off`, retaining context occupancy when supplemental statistics are disabled.
- Emit recognizable local context/payload overflow errors for OMP recovery and document provider-specific compaction thresholds.
- Verify actual OMP automatic compaction with Flash and a synthetic occupancy trigger; benchmark usage-query latency over six Flash turns.

## 0.1.7 — 2026-10-20

- Replace the 32,000-character reconstruction cutoff with bounded full-history transfer, explicit overflow errors and historical image attachments.
- Read official advertised `/usage` totals and attach per-turn main-agent token deltas, including thinking output; mark absent cache metadata unknown.
- Supply ACP context occupancy independently of aggregate consumption through OMP's `usage.contextTokens` field.
- Reclaim idle runtimes after five minutes while protecting active streams, pending tools and permissions; preserve server session restoration.
- Stabilize tool ordering and context resource identifiers to avoid unnecessary prefix changes, without promising backend cache hits.
- Add offline regressions, Flash-only continuity/resource measurements and opt-out performance settings.

## 0.1.6 — 2026-10-20

- Rename the project, npm package and marketplace plugin to `omp-antigravity-acp-provider`.
- Preserve the `antigravity-acp` provider ID, commands, configuration and session paths.
- Retain upstream fork attribution.

## 0.1.5 — 2026-10-20

- Hide duplicate ACP tool-status lines by default; `/antigravity-acp debug on|off` controls their display immediately without recreating the connection.
- Preserve normal OMP tool calls/results, real thought events, plans and SDK progress watchdog updates.
- Persist the debug option independently of native-tool filtering and retain existing 0.1.4 policy files.
- Add presentation, settings and live same-session debug-toggle checks.

## 0.1.4 — 2026-10-20

- Append OMP tool-routing instructions to the official ACP system prompt and eagerly load pi-bridge tools on supported runtimes.
- Add `/antigravity-acp native-tools prefer|disabled` with an independent OMP policy file. Default to prefer; disabled mode filters native built-ins and fails closed on incompatible runtimes.
- Apply session metadata to new/load/resume, preserving routing after model changes and clearing persisted native-tool filters when returning to prefer mode.
- Add offline routing/policy regressions, explicit live metadata/restoration probes, and research reports distinguishing absent server thought output from client display behavior.

## 0.1.3 — 2026-10-20

- Add npm ecosystem/resource keywords used by zmarketplace to discover OMP extensions.
- Clarify the package description and document zmarketplace search and OMP installation.
- Keep adapter runtime behavior unchanged from 0.1.2.

## 0.1.2 — 2026-10-19

- Discover all server-advertised ACP models without a Gemini-only whitelist, including grouped model selectors and legacy catalogs.
- Read thinking options per model and preserve every advertised OMP-compatible effort, including off, minimal, xhigh and max.
- Migrate existing cached catalogs on refresh; use conservative metadata and unconfigured cost placeholders for unknown models.

- Add the GitHub-hosted sencha-plugins OMP marketplace and a source launcher for the published adapter.
- Prepare production dependencies atomically on first load and reuse the cache offline afterward; npm install scripts and unnecessary Pi CLI peers are disabled.
- Add marketplace provisioning regressions and an isolated end-to-end install/uninstall check.

## 0.1.1 — 2026-10-19

- Make the derivative fork relationship, upstream authorship and OMP-specific modification scope explicit in the README, package metadata and third-party notices.
- Prepare a public npm package with a prebuilt runtime, portable asset resolution, bundled dependency notices and installation instructions.
- Add repository links and publication-time checks.

## 0.1.0 — 2026-10-19

- Extract the locally verified OMP adapter into a portable source project.
- Support official ACP model and thinking selectors for Argon and Flash.
- Keep startup and model listing offline with cached discovery.
- Prefer OMP tools through the authenticated MCP bridge.
- Estimate API-equivalent token costs separately from subscription charges.
- Scope runtimes by OMP session and recreate them after planning-session shutdown.
- Resolve upstream supervisor and runtime-manifest assets at runtime.
