# omp-antigravity-acp-provider

[![npm version](https://img.shields.io/npm/v/omp-antigravity-acp-provider.svg)](https://www.npmjs.com/package/omp-antigravity-acp-provider)
[![npm downloads](https://img.shields.io/npm/dm/omp-antigravity-acp-provider.svg)](https://www.npmjs.com/package/omp-antigravity-acp-provider)

Google Antigravity's official ACP server, adapted for **Oh My Pi (OMP)**.

**An OMP-focused derivative fork of [zacbemis/pi-antigravity-acp-provider](https://github.com/zacbemis/pi-antigravity-acp-provider).** Original project by [zacbemis](https://github.com/zacbemis) and contributors, licensed under MIT.

This is an independent adaptation, not an official Google or OMP integration. It uses ACP over stdio. The local HTTP MCP bridge carries tool calls; it is not a model API reverse proxy.

## Upstream and fork scope

The original project's ACP transport, Google-managed authentication, runtime installation, session restoration and MCP tool bridge form the foundation of this project. Credit for those capabilities belongs to the upstream authors.

This derivative adds OMP-specific provider registration, confirmed model/thinking selectors, lazy catalog loading, OMP-first tool instructions, API-equivalent pricing and per-session runtime lifecycle fixes for planning/refinement.

The repository vendors the upstream **0.1.15** source under `extension/vendor/pi-antigravity-acp-provider` (MIT, see `extension/vendor/pi-antigravity-acp-provider/LICENSE`). The standalone artifact bundles its runtime code, supervisor and signed runtime manifest; end users need no production npm dependencies. It does not contain a copy of upstream's Git history. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the original copyright and license notice.
## Status

Version 0.1.24 protects cross-process session ownership even when ACP shutdown times out, isolates adapter state by OMP agent directory, and preserves registries with unsupported records. Restart all OMP processes after upgrading so they participate in session ownership.

Version 0.1.24 supports all models advertised by the official ACP server. Earlier live inference was tested with macOS, OMP 18.12.5, upstream provider 0.1.15 and official ACP runtime 1.4.1. The 0.1.21–0.1.24 continuity fixes are verified offline, including OMP 18.13.3 catalog loading and the local OMP summarizer source. Other platforms and full interactive Refine plan behavior with a real model remain unverified.

Google's consumer-plan policies can restrict third-party agent access even through the official CLI or ACP executable. An official transport does not establish permission to use a subscription in OMP. Check the current [Antigravity FAQ](https://www.antigravity.google/docs/faq/) and [terms](https://antigravity.google/terms) for your account.

## Features

- All server-advertised model IDs, without a Gemini-only whitelist. Claude, GPT-OSS or future models become available when the ACP endpoint advertises them for your account.
- Per-model, server-confirmed thinking selection. OMP efforts `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max` are exposed only when advertised; models without these choices use the server default.
- Compatible OMP tools exposed through an authenticated loopback MCP bridge.
- Provider-specific instructions prefer OMP tools and require approval before substituting native Antigravity tools. Supported runtimes receive these instructions through the official system-append extension and eagerly register the pi-bridge tools.
- Optional native built-in tool filtering; default `prefer` mode keeps native tools available, while `disabled` mode removes native built-ins for this adapter's ACP sessions.
- Duplicate gray ACP tool-status lines are hidden by default, with an optional debug display switch. OMP tool calls/results and actual thought summaries remain visible.
- Lazy ACP startup; model selection and cached listing do not launch the server.
- Runtimes scoped to OMP sessions, including recovery after a planning session is disposed.
- OMP `/login` support plus `/antigravity-acp login`, `logout` and `account` commands; OMP's `/logout` automatically finishes the Antigravity-side logout, including the macOS keychain entry the Antigravity server owns.
- API-equivalent cost estimates, not subscription billing or quota measurements.

## Install from the OMP marketplace

No server is needed: this GitHub repository is also an OMP marketplace named **sencha-plugins**.

Add the source once, then install the plugin:

```sh
omp plugin marketplace add SenCha930511/omp-antigravity-acp-provider
omp plugin install omp-antigravity-acp-provider@sencha-plugins
```

Or, inside OMP:

```text
/marketplace add SenCha930511/omp-antigravity-acp-provider
/marketplace
```

Select **omp-antigravity-acp-provider** in the browser, install it, and restart OMP to load the provider.

OMP's marketplace installer currently copies Git content without installing npm dependencies. This marketplace therefore ships a small source launcher that retrieves the exact published **0.1.24** prebuilt npm adapter on first load. It disables npm install scripts and performs no local compilation. Node.js 22.19+ and npm must be on PATH. The standalone build bundles the required code and supervisor assets with no production dependencies: a clean test installation occupied approximately **2.6 MiB** (477 KiB tarball), down from roughly 150 MiB with the old dependency tree. This excludes the separately downloaded Google runtime. First preparation needs internet access; later loads reuse the installed cache without npm network access.

The launcher stores its versioned dependencies in `.runtime/` inside the installed marketplace plugin's cache directory. Uninstalling the marketplace plugin removes that cache when it is no longer referenced by another scope. Google credentials and the separately downloaded official ACP runtime are unaffected.

Use either marketplace installation or direct npm installation for this provider. Disable/remove an existing installation before switching to avoid duplicate provider registration. Adding this source makes it available to users who add **sencha-plugins**; it does not submit the package to a central curated store.

To refresh the catalog and upgrade an existing marketplace installation:

```sh
omp plugin marketplace update sencha-plugins
omp plugin upgrade omp-antigravity-acp-provider@sencha-plugins
```

## Install directly from npm

The prebuilt package is published on [npm as `omp-antigravity-acp-provider`](https://www.npmjs.com/package/omp-antigravity-acp-provider). Use Node.js 22.19 or newer and OMP to install the latest release:

```sh
omp plugin install npm:omp-antigravity-acp-provider
```

To pin a specific release:

```sh
omp plugin install npm:omp-antigravity-acp-provider@0.1.24
```

Restart OMP after installation. The npm package includes the built adapter; users do not need esbuild or a manual build step. Disable any older ACP adapter for the same provider before loading this package.

The standalone npm package has no production dependencies or Pi CLI peers. Source development uses the pinned upstream build dependency and this repository's `.npmrc`.

## Find it with zmarketplace

[zmarketplace](https://github.com/zico20047/zmarketplace) searches npm using ecosystem keywords; it has no separate submission catalog. This package includes the `pi-package` keyword used for both Pi and OMP discovery, plus `extension` and `plugin` resource tags. These discovery tags do not establish compatibility with untested agent runtimes; this adapter targets OMP.

With zmarketplace already installed in OMP:

```text
/zmarketplace search omp-antigravity-acp-provider --eco=omp --type=extension
```

Or search from a terminal with Bun:

```sh
bunx zmarketplace search omp-antigravity-acp-provider --eco=omp --type=extension
```

Use the OMP installation target when installing from the search result. The direct OMP command is `omp plugin install npm:omp-antigravity-acp-provider`. Newly published metadata may take time to appear in npm search results.

## Build from source

Use Node.js 22.19 or newer and OMP. Node.js is also required by the upstream process supervisor.

```sh
git clone https://github.com/SenCha930511/omp-antigravity-acp-provider.git
cd omp-antigravity-acp-provider
npm ci
npm run check
```

The checked-in npm configuration disables automatic peer installation because the upstream package declares Pi-specific peers. This adapter explicitly supplies its runtime dependency on `pi-ai`; it does not need the Pi coding-agent CLI.

The build produces `extension/runtime.mjs`, `extension/assets/` and `THIRD_PARTY_LICENSES.txt`. They are ignored by Git, rebuilt locally and included in published npm tarballs. Supervisor and runtime catalog paths resolve against these bundled assets, so the bundle does not embed the developer's home directory.

For a temporary session, from this repository:

```sh
omp --no-extensions -e ./extension/index.ts
```

This disables other extension discovery for that invocation, avoiding duplicate registration of an existing ACP adapter. For normal installation, use OMP's extension configuration or point `~/.omp/agent/extensions/omp-antigravity-acp-provider` at the built `extension` directory. Disable any previous `antigravity-acp-omp` or upstream Pi extension first; do not load two adapters for the same provider.

This repository does not change an existing OMP installation or overwrite its settings.

## Sign in and choose a model

1. Run `/login` and select **Google Antigravity (ACP)**.
2. Complete Google's authorization flow. On headless machines the upstream provider can relay a browser callback.
3. Run `/antigravity-acp refresh` to discover the models actually advertised for the account.
4. Select a model with `/model` and use OMP's thinking control to select a supported effort.

`/antigravity-acp login` runs the same Google authorization through a command dialog without touching OMP's stored account record; use it to re-authenticate or switch the Antigravity-side Google account. `/antigravity-acp account` shows the current authentication state on both sides.

Both login paths always start a fresh Google sign-in: stored Antigravity credentials are cleared first, so the Google account chooser is always offered and a saved login cannot silently keep the previous account. The Google browser session itself is outside this adapter's control; pick the intended account (or "Use another account") on Google's consent screen.

First use or login may download the official runtime. The observed macOS runtime occupies about **383 MiB**; size varies by platform/version. It lives outside this repository under `~/.local/opt/agy-acp/`. Do not remove it while ACP processes are running.

If OMP's `enabledModels` whitelist is configured, add `antigravity-acp/*` alongside your existing entries in `~/.omp/agent/config.yml` to allow newly discovered models. Use individual `antigravity-acp/<server-model-id>` entries instead if you prefer a restricted list. The adapter does not rewrite that whitelist or any model-role preset.

After upgrading from an older adapter, run `/antigravity-acp refresh` once to replace the old cached list with per-model selector choices. Startup and ordinary catalog listing remain offline, so new server models appear after an explicit refresh. Availability in the Antigravity app or CLI does not guarantee availability through ACP: on the tested account, ACP still advertised only `gemini-4-argon` and `gemini-3.8-flash` on 2026-10-20.

## Commands

| Command | Purpose |
| --- | --- |
| `/antigravity-acp account` | Signed-in Google account and authentication state on both the OMP and Antigravity sides |
| `/antigravity-acp login` | Run the Antigravity Google authorization in a command dialog |
| `/antigravity-acp logout` | Clear Antigravity credentials, saved ACP sessions and OMP's marker record |
| `/antigravity-acp status` | Runtime, confirmed thinking and usage information |
| `/antigravity-acp usage` | Current ACP context occupancy, accounting source and cache-data availability |
| `/antigravity-acp usage auto` | Enable supplemental usage queries |
| `/antigravity-acp usage off` | Skip supplemental queries; preserve context occupancy updates |
| `/antigravity-acp context` | Show saved settings and effective per-model budgets |
| `/antigravity-acp context set default KEY NUMBER` | Set a default token or payload setting |
| `/antigravity-acp context set MODEL KEY NUMBER` | Override one advertised model ID |
| `/antigravity-acp cleanup` | Show cleanup mode/deadline and check eligible local sessions |
| `/antigravity-acp cleanup off` | Disable automatic session-file deletion |
| `/antigravity-acp cleanup conservative` | Delete confirmed replaced/disposable sessions only (default) |
| `/antigravity-acp cleanup timeout DAYS` | Also delete inactive unmapped owned sessions after DAYS (default 7) |
| `/antigravity-acp cleanup budget MAX_SESSIONS MAX_MIB` | Set soft session-count/size budgets; `0` disables each limit |
| `/antigravity-acp diagnostics [on\|off\|reset]` | Show bounded timing samples, enable/disable collection, or clear samples (default off) |
| `/antigravity-acp tools` | Available and omitted OMP tool schemas after a request |
| `/antigravity-acp refresh` | Explicit network discovery and local catalog refresh |
| `/antigravity-acp native-tools prefer` | Prefer OMP tools; retain native built-ins (default) |
| `/antigravity-acp native-tools disabled` | Disable native built-ins for this adapter's ACP sessions |
| `/antigravity-acp debug on` | Show ACP tool-status lines for debugging |
| `/antigravity-acp debug off` | Hide ACP tool-status lines (default) |
| `/antigravity-acp permissions default` | Prompting permission mode |
| `/antigravity-acp permissions auto-edit` | Auto-edit mode |
| `/antigravity-acp permissions yolo` | Upstream permissive mode |

The initial permission mode follows upstream configuration, whose default is `yolo`. Native Antigravity tools have separate execution permissions from OMP tools.

### Sign out

OMP's oauth contract has no provider-side logout hook, so `/logout` by itself only removes OMP's stored non-secret marker record. This adapter watches the credential store and finishes the Antigravity-side logout automatically: after `/logout` removes the marker, it closes this process's ACP runtimes, clears saved ACP session mappings, deletes the local token file and the settings auth choice, and removes the matching macOS keychain entry, then confirms with one line (`/antigravity-acp account` shows the details). The keychain removal waits for this adapter's ACP server processes to fully exit and verifies the deletion, because a dying server can flush its token back. The cleanup waits for in-flight Antigravity requests to finish, a re-login before it runs cancels it, and automatic credential soft-disables (for example an expired refresh grant) never trigger it. Set `OMP_ACP_FOLLOW_LOGOUT=0` before starting OMP to keep OMP's `/logout` marker-only. `/antigravity-acp logout` performs the same complete logout in one command without waiting for OMP; it refuses to run while Antigravity requests are active. If its OMP-marker removal is unavailable through the host API, the command says so and OMP's `/logout` finishes that part.

The provider's non-secret config apiKey fallback is registered only until a logout is observed: removing the marker credential makes the adapter re-register without it in the same tick, so OMP's own logout report finds no remaining "provider config (fallback)" source and the model catalog hides until the next `/login`. Fresh profiles that never stored a marker keep the fallback so first-run model listing works; storing a marker again restores it.

The debug switch controls gray `[Antigravity tool: …]` and `[Antigravity tool update: …]` lines. It defaults to off and applies immediately to this process's active ACP connections. Normal OMP tool displays/results, real thought chunks and plan messages are preserved. The option is saved as `debugToolUpdates` in `omp-tools.json` alongside `nativeTools`; toggling either option preserves the other. Existing policy files without the debug field default to off. Other OMP processes need a restart to read a setting changed elsewhere. `OMP_ACP_TRACE=1` is a separate, opt-in terminal diagnostic setting.

## OMP tool routing and native-tool mode

By default, `prefer` mode sends the OMP-first instruction through `_meta.antigravity.systemPrompt.append` and preloads the `pi-bridge` tools with `eagerMcpServers`. These are official runtime extension fields on session new/load/resume, not model API requests. The adapter preserves conversation-level instructions as well. Prompt preference can still be ignored by a model; it does not enforce a tool allowlist.

Eager loading supplies tool schemas up front, which can increase initial prompt size compared with lazy discovery.

For strict native built-in filtering, run `/antigravity-acp native-tools disabled`. This sets `enabledTools: []` in the session extension while retaining the OMP MCP bridge. Run `/antigravity-acp native-tools prefer` to restore native tool availability. The command closes this process's ACP runtimes; the next request recreates/restores them with the selected policy. Switching back explicitly clears the saved server filter, including on restored sessions.

The setting is stored separately in `~/.omp/agent/antigravity-acp-provider/omp-tools.json` as `{"nativeTools":"prefer"}` or `{"nativeTools":"disabled"}`. It applies to this adapter and does not configure other providers. Other already-running OMP processes need to restart to pick up a change. Native filtering does not remove separately configured global MCP servers and is not a filesystem sandbox. Unsupported or omitted OMP tool schemas remain unavailable; disabled mode cannot substitute native tools for them.

Advanced routing requires the official `antigravity-acp` 1.x server, version 1.4.1 or newer, advertising system-append support in its agent capabilities. On an incompatible server, `prefer` falls back to the conversation-level prompt; `disabled` rejects session creation/restoration rather than silently allowing native tools. `/antigravity-acp status` shows the selected mode and whether active connections use system append or the legacy prompt channel. Live behavior has been verified on server 1.4.1.

## Data locations

| Data | Location |
| --- | --- |
| Adapter configuration, catalog and session mappings | `~/.omp/agent/antigravity-acp-provider/` |
| OMP-specific native-tool policy | `~/.omp/agent/antigravity-acp-provider/omp-tools.json` |
| Official credentials/settings/history | Managed by Antigravity under its own storage/keychain |
| Downloaded official runtime | `~/.local/opt/agy-acp/` |
| Generated adapter bundle | `extension/runtime.mjs` |

Never include those user data directories, OAuth callback URLs, account identifiers or downloaded runtime binaries in issues or commits. `OMP_ACP_TRACE=1` enables opt-in tool/selector diagnostics; review diagnostic output before sharing.

## Context continuity and local performance

Each runtime also keeps bounded, value-validated system-message and tool-definition snapshots. Equivalent new containers reuse the existing canonical fingerprint/tool projection fingerprint; every selected field is still checked, including in-place schema edits and non-enumerable schema properties. Unsupported shapes fall back to the original algorithm. Each of the two caches holds one entry, capped at 32,768 value nodes, 131,072 primitive snapshot items and 2,097,152 UTF-16 code units in keys/string values; these are local snapshot limits, not model tokens or context limits. Tool execution closures are not retained, and runtime teardown clears the caches.

Session mappings use asynchronous file I/O and nonblocking cross-process lock retries, with ordered read/merge/atomic-rename writes. Each request saves a versioned in-flight marker before dispatch and clears it only with an accepted terminal checkpoint. A failed checkpoint, unknown prompt failure or incomplete tool/permission fallback cannot be trusted as a warm restoration point. Legacy mappings without the marker are reconstructed once from retained OMP history; subsequent clean checkpoints remain resumable. Invalidated turns cannot repersist old mappings, and conditional removal preserves a newer replacement. Local preflight failures retain known-good warm sessions. Cancellation checkpoints are awaited before the turn releases its queue; shutdown waits for active checkpoint writes and rechecks dispatch eligibility afterward. Malformed JSON/non-array registries and I/O failures are reported rather than silently overwritten. Cleanup registry transactions, file scans and deletion also use asynchronous I/O; small command/configuration reads remain synchronous. This does not remove Google's cancellation-confirmation wait. See the [continuity invariants](docs/session-continuity.md), [Esc performance implementation and measurements](docs/esc-session-performance-research.md#production-implementation) and [resource-management notes](docs/resource-management.md).

History comparisons reuse SHA-256 digests for unchanged large, simple messages. Every lookup validates the selected live fields against an independent snapshot, including nested tool arguments and in-place text edits; object identity alone never establishes a match. Small messages (below 2,048 characters per text/image/thinking string), complex payloads and unsupported objects use the original algorithm. The digest format and all checks after asynchronous work remain unchanged, so saved sessions stay compatible. Weak keys allow snapshots to be reclaimed when OMP drops old messages, including after compaction. This reduces local comparison work; it does not increase Google's cache-hit rate or guarantee faster model generation. See the [offline benchmarks and memory measurements](docs/history-comparison-research.md#production-integration).

New user requests supersede an interrupted ACP turn, including pending tool calls and permission prompts. The adapter cancels old waits and sends official `session/cancel`, then waits up to the existing 1.5-second cancellation deadline for the old turn to settle. A confirmed cancellation (or a clean completion racing with cancellation) keeps the warm ACP session when the transport is alive and the retained OMP history matches. New prompts queue behind that drain and are sent as new requests, never silently treated as old tool-result continuations. Ordinary completed turns and genuine tool continuations also stay warm. Tool/permission continuations claim one owner before asynchronous work; overlapping duplicates receive an explicit error instead of stealing the response stream. Changed or missing completed assistant output forces reconstruction so the backend and OMP-visible histories agree.

The cancellation checkpoint records the accepted message boundary and the partial assistant output fingerprint, including across idle shutdown/resume. If cancellation is unacknowledged, the process fails, the history is edited/compacted, or previously emitted partial output is missing or changed in OMP, the adapter reconstructs from retained history instead. Thus Esc does not always create a new ACP session, but reuse is conditional rather than guaranteed. Cancelled turns skip supplemental `/usage` queries while retaining any ACP context-occupancy update. History is explicitly separated from the current request after official ACP text conversion; cold tool handoffs resume from completed results rather than restarting prior actions. Preserving a session avoids unnecessary replay but does not guarantee a backend cache hit. See the [Flash cancellation/cache research and implementation checks](docs/cache-cancellation-research.md).

The adapter transfers complete replay history within bounded budgets, including historical image attachments. It does not silently keep only a history tail. The official harness also has a per-step text conversion limit independent of its model window: the inspected configuration limits a step to 64,000 tokens and truncates oversized text to its first 192,000 UTF-8 bytes. A large cold replay after **Refine plan** can therefore lose the latest question at the tail even when the advertised model window has room. The adapter rejects rendered prompt text above 188,000 bytes before `session/prompt`, leaving 4,000 bytes for official wrapping/metadata. The context-overflow error lets OMP use its existing compaction/retry flow; OMP's adaptive summary windows can split oversized summary input too. If compaction is disabled or cannot reduce the request, use `/compact` or reduce the input before retrying. The adapter itself neither summarizes nor adds inference. See [step-limit behavior and offline validation](docs/plan-refinement-step-limit.md).

Token budgets, wire payload size and the per-step text limit are independent. The default wire payload limit is 16 MiB, configurable up to 128 MiB; raising it or `contextWindow` does not bypass the per-step text guard. Image data additionally defaults to an 8 MiB decoded payload limit and is not counted as rendered text. The automatic input-token budget is `contextWindow - maxTokens - reserveTokens`, where reserve defaults to the smaller of 16,384 and 5% of the window. A lightweight Unicode-aware estimate checks serialized text plus approximately 4,096 tokens per image. This is not a Gemini tokenizer, cannot guarantee exact token counts and does not include every hidden server instruction.

Persist settings in `~/.omp/agent/antigravity-acp-provider/context.json`, or use the commands below. Defaults apply to every ACP model; entries under `models` override one advertised model ID. Model limits are client metadata and transfer budgets: they do not expand Google's server window or set an unsupported ACP generation-output parameter.

```json
{
  "defaults": {
    "contextWindow": 524288,
    "maxTokens": 32000,
    "reserveTokens": 16384,
    "maxTransferBytes": 16777216,
    "maxImageBytes": 8388608,
    "usageMode": "off"
  },
  "models": {}
}
```

Numeric keys: `contextWindow`, `maxTokens`, `reserveTokens`, `inputTokenBudget`, `maxTransferBytes`, `maxImageBytes`. Omit `inputTokenBudget` to calculate it automatically. A custom input budget must fit alongside output and reserve. Settings load once per process, without disk reads on every streamed chunk. Direct file edits require a restart; commands persist settings and refresh registration in the current process. Restart OMP or reselect the model to refresh displayed metadata. Other OMP processes must restart.

```text
/antigravity-acp context
/antigravity-acp context set default maxTransferBytes 33554432
/antigravity-acp context set gemini-4-argon contextWindow 1000000
/antigravity-acp usage off
/antigravity-acp usage auto
```

For OMP-managed automatic compaction, keep `compaction.enabled`, `compaction.midTurnEnabled` and `compaction.autoContinue` enabled with a working method such as `soft`. A provider-specific threshold can be set without changing other providers:

```sh
omp config set compaction.modelThresholds '{"antigravity-acp/*":"85%"}'
```

Merge that map with existing model-specific entries before running the command. At the example 524,288-token window, 85% triggers at 445,644 tokens, below the automatic transfer estimate budget of 475,904 tokens. OMP can also recover from local context/payload overflow errors. Google independently controls its internal agent summaries. Plugin installation does not automatically change OMP's global compaction configuration.

Active sessions are reused. After five idle minutes, the adapter closes its ACP runtime, bridge and child processes; the next request tries to restore the saved server session. It also keeps at most two idle runtimes per OMP process by default, evicting the least recently used idle entry when necessary. Active streams, outstanding ACP prompts, tools and permission waits prevent eviction. Process eviction preserves mapped session files. No background model prewarming, quota polling or tokenizer model download is performed.

### Local ACP session cleanup

Session-file deletion is separate from the five-minute idle process shutdown. Configure one of three modes:

| Mode | Behavior |
| --- | --- |
| `off` | Keep session files, including replaced sessions. Ownership/lease bookkeeping remains enabled so cleanup can be enabled later. |
| `conservative` (default) | Remove an old session after its OMP history is rebuilt (for example after `/compact`), a replacement successfully completes a turn, and all registered users of the old session have released it. Disposable model-discovery sessions are also removed after their connection exits. Ordinary shutdown and idle eviction preserve resumable sessions. |
| `timeout` | Conservative cleanup plus removal of unmapped owned sessions whose last activity exceeds `idleDays`, or eligible unmapped sessions above a configured soft budget after the orphan grace period. Default 7 days; accepts fractional days (for example `0.5` for 12 hours), with a minimum of one hour and a maximum of 3650 days. Saved OMP mappings and live leases always override deletion. |

```text
/antigravity-acp cleanup
/antigravity-acp cleanup off
/antigravity-acp cleanup conservative
/antigravity-acp cleanup timeout 7
/antigravity-acp cleanup budget 50 512
```

Settings persist in `~/.omp/agent/antigravity-acp-provider/cleanup.json`:

```json
{ "mode": "conservative", "idleDays": 7, "maxSessions": 0, "maxBytes": 0, "orphanGraceDays": 1, "batchSize": 8 }
```

The optional budgets default to disabled (`0`); the command accepts MiB and saves bytes. Size accounting uses logical file sizes rather than allocated APFS space. In `off` and `conservative`, exceeding a budget only produces a status warning. In `timeout`, budget eviction uses least-recent activity among unmapped, unleased owned sessions after `orphanGraceDays` (default 1 day, range 1 hour–3650 days). Mapped and active sessions can keep usage above the budget. The grace period applies to budget eviction; confirmed replacement and ordinary idle expiry have their own eligibility rules.

Commands take effect immediately; direct file edits are read on the next cleanup check. Checks run when the cleanup service starts, after replacement/release, on the inspection command, and every 15 minutes while the service is running. Replacement/release persists bookkeeping before scheduling file cleanup in the background. Each batch removes at most `batchSize` sessions (default 8, range 1–100); eligible overflow schedules another batch after one second. OMP must be running for timed checks; the deadline is not an exact scheduled deletion time. No additional model requests, tokenizer downloads or background worker processes are used.

Only sessions created and registered by this adapter version onward are eligible. Pre-existing/unidentified ACP sessions are preserved. All cleanup modes protect IDs in saved `sessions.json` mappings. The registry is separated by the resolved ACP storage root, and tracks both OMP and ACP supervisor PIDs across participating processes. Resume/load acquires a lease before replay; the cross-process lease lock remains held during asynchronous deletion. Busy/corrupt registries, malformed mappings and unsafe paths defer deletion. Failed lifecycle updates remain in a bounded in-memory retry queue (1024 entries) until the next successful transaction; a process crash can lose queued intentions, so deletion is never guaranteed. The status shows mapped/unmapped/active counts, logical bytes, deferred work, failures and pending updates. Restart older OMP instances when upgrading: clients that do not implement these leases, or external clients manually opening the same session, are outside this coordination mechanism.

Cleanup targets only the registered UUID's `.db`, SQLite journal/WAL/SHM files, `.meta`, and `brain/<UUID>` directory under the ACP storage root (normally `~/.gemini/antigravity-acp/`; respects `GEMINI_HOME`). Symlinked targets are preserved. Credentials, global settings, shared artifacts, workspace files and OMP's own conversation history are untouched. Local deletion is permanent and does not request deletion of Google's server-side logs. The current official ACP runtime does not advertise session deletion, so this uses the inspected local layout rather than an unsupported RPC.

Timeout cleanup sacrifices ACP-only reasoning/checkpoint state for eligible unmapped sessions. If that session is later requested through another history source, the adapter reconstructs it from OMP's retained history and can incur replay latency and a different token count. Cache expiry is not assumed or guaranteed. Ordinary mapped conversations remain resumable in every mode; budgets cannot bound the number of mapped OMP conversations you keep.

### Deleting an OMP conversation

Version 0.1.20 can reconcile deleted OMP journal files with their ACP mappings. On `session_start`, `session_switch` and `agent_end`, it records the file path only after reading a matching OMP session header and finding an adapter-owned ACP mapping. It supports the managed `sessions/` root beside the provider state directory, including named profiles. Custom/external storage and old mappings without a verified source remain protected until supported or observed again; merely installing the build does not identify every old mapping.

With `conservative` or `timeout`, a tracked source must be absent on two cleanup checks at least 60 seconds apart, have no live ACP leases, and remain absent after a bounded search of the managed journal buckets for the same header ID. Moving/renaming a journal within those buckets updates its path. Missing/replaced storage roots, symlinks, malformed headers, permission errors and scan limits preserve data. Only then does cleanup conditionally remove the matching mapping and make the owned ACP session eligible for the existing deletion batches. Newer mappings are protected by the mapping store's lock. Turning cleanup `off` preserves both mapping and files.

This is eventual reconciliation, not a synchronous OMP delete callback. OMP must be running; periodic checks are 15 minutes apart, so idle detection commonly needs two checks (up to roughly 30 minutes after deletion). The cleanup command can trigger checks manually, but cannot bypass the one-minute confirmation interval or live leases. Closing, switching or archiving a conversation leaves its journal intact and does not request deletion. There are no model calls or continuous transcript watchers. Normal checks inspect tracked paths; relocation scans run only for missing sources and are shared within one sweep, bounded to 20,000 entries, four directory levels and 64 KiB per journal prefix.

### Optional timing diagnostics

Use `/antigravity-acp diagnostics on`, then `/antigravity-acp diagnostics` to inspect timings for history/tool comparisons, session initialization/restoration, checkpoint writes, prompt/first-output and cancellation confirmation. `/antigravity-acp diagnostics reset` clears samples; `off` disables collection and clears them. This is separate from the tool-status debug switch.

Collection defaults to off and retains at most 128 samples in memory. Only the enabled flag persists in `diagnostics.json`; samples contain stage names and durations, without request content, account identifiers or session IDs. It sends no model/usage requests. Prompt timings include Google processing and tools, and are not a measure of local comparison cost alone.

Optional environment settings, applied when OMP starts:

| Setting | Default | Effect |
| --- | --- | --- |
| `OMP_ACP_HISTORY_BYTES` | context.json or 16 MiB | Optional byte-limit override, 64 KiB–128 MiB; independent of token window |
| `OMP_ACP_IDLE_TIMEOUT_MS` | `300000` | Idle runtime reclamation; `0` disables it, positive values must be at least `1000` |
| `OMP_ACP_MAX_IDLE_RUNTIMES` | `2` | Per-process idle runtime LRU limit; `0` disables the limit. Busy/leased runtimes remain protected |
| `OMP_ACP_USAGE` | context.json or auto | `off` forces supplemental queries off, including when the saved option is auto |

When automatic usage is enabled and `/usage` is advertised by the official server, the adapter queries it after each completed ACP prompt and computes a difference from the previous cumulative snapshot. A restored session first establishes a baseline so its old tokens are not charged again. These are main-agent totals and can include multiple internal model calls. Thinking tokens count toward estimated output cost. Queries are bounded by a five-second deadline; unavailable/malformed usage or a counter reset does not turn a successful model answer into a billing claim. Native ACP response usage takes priority when supplied. Query failures can cancel/retire the connection; subsequent work can restore the server session.

Supplemental queries default to `auto` for compatibility; the example above opts out. Use `/antigravity-acp usage off` to reduce the delay between the last text chunk and OMP regaining control, or `auto` to retain available token/cache/cost estimates. In a Flash Low test with three turns per mode, that final delay had a median of **282 ms with auto vs 21 ms with off** (261 ms less). Individual queries took 241–580 ms. This small sample does not establish a universal speedup, and total response time also varies with inference. Turning queries off preserves ACP context-occupancy updates used by OMP compaction; missing accounting data stays unavailable.

ACP `usage_update.used` is passed to OMP separately as `usage.contextTokens`, rather than treating aggregate billable consumption as context occupancy. OMP 18.12.3 recognizes this field; it can still use a local stored-history estimate when deciding whether to compact. Google continues to control its own internal summaries.

Stable tool ordering and stable context-resource identifiers avoid unnecessary client-side prefix changes. They do not guarantee implicit cache hits. `/antigravity-acp usage` marks cache information as `unknown` when Google omits it; zero cache fields in OMP's numeric usage structure must not be read as proof of zero backend caching. If cache counts are missing, the API-equivalent estimate prices input as uncached and cannot reflect any unreported cache discount. This is not a subscription bill or a measurement of quota deduction.

See the [0.1.8 context/compaction and usage benchmark](docs/context-compaction-0.1.8.md) for current settings and measurements. The [0.1.7 report](docs/continuity-performance-0.1.7.md) documents the previous implementation.

## Limitations

- Argon/Flash default to client metadata of 1,000,000 context tokens and 65,536 output tokens. These can be overridden in context.json. Other models use conservative defaults of 32,768 context tokens and 8,192 output tokens because the model selector does not supply these limits. These are client metadata, not verified server limits or controls over Antigravity's internal compaction.
- API background execution and long decode controls are not exposed.
- The bridge advertises text and image input, not the full Gemini API media surface.
- Thought summaries appear only if the ACP server emits them. A verified Argon High request returned no `agent_thought_chunk`; plan progress and optional debug tool-status lines can appear in OMP's thinking area.
- Cached-token usage appears only when ACP reports it. Missing counts are not proof that backend caching was disabled.
- The prompt inactivity watchdog is 10 minutes without progress, or 60 minutes while tools/permissions are outstanding.
- Argon estimates use the undiscounted list price: $4 input, $20 output and $0.20 cached input per million tokens. Flash estimates use the announced date-dependent rates. These are snapshots, not live pricing discovery.
- Other models have no configured API price yet. Their zero cost fields are placeholders for unavailable estimates and do not mean free usage.
- Not every OMP tool schema is bridge-compatible. Inspect `tools` after a request.
- Antigravity still manages its own native tools and checkpoint summaries.

## Development and verification

`npm test` runs offline regression tests for all-vendor catalogs, per-model thinking choices, selector routing, session ownership, restart-after-shutdown, asynchronous teardown and price calculations. It performs no model inference and consumes no account quota.

`npm run test:omp-compaction` additionally requires `OMP_ACP_TEST_OMP_SOURCE` pointing to an OMP source checkout with built dependencies. An optional `OMP_ACP_TEST_NATIVE_ADDON` can point to an installed OMP native addon when the checkout has no built addon. It runs OMP's real adaptive summary-window algorithm with synthetic completions, verifies that all history windows are visited, and checks that a compacted plan refinement retains the newest question. It performs no inference and does not modify the OMP checkout.

`npm run test:usage` uses Bun and mocked protocol responses to verify restored-session baselines, counter resets, query failures and advertised-command gating without starting ACP. `bun scripts/verify-continuity-live.ts --live` is a separate Flash-only probe of long history, synthetic tools, usage accounting and idle process reclamation/restoration; it consumes quota. Its one-second idle setting is isolated to the test process and is not the production default.

`npm run test:auth` uses Bun with an isolated `GEMINI_HOME`, a stubbed keychain and a stubbed OAuth flow to verify the account view (including Google-account email extraction from the stored id_token), login dialog mapping, logout cleanup, the active-request guard and the credential-store watch behind OMP-logout following (removal, automatic-disable suppression, re-login cancellation, opt-out and busy deferral) without starting ACP. Real Google login and logout change account state, so they are not part of any automated test.

`npm run test:packed` additionally requires OMP on PATH. It installs the exact npm tarball into a temporary consumer directory with development dependencies omitted and install scripts disabled, checks the standalone assets and supervisor, verifies there are no production dependencies, measures package size, and loads its model catalog with ACP execution disabled. It removes the temporary installation afterward.

`npm run test:marketplace` exercises catalog discovery, installation, automatic provider loading, offline cache reuse and uninstallation in a temporary named OMP profile. It downloads the published adapter and cleans the entire test profile afterward. Add `-- --remote` after publishing catalog changes to test the GitHub source instead of the local working tree. No model inference is performed.

`bun scripts/verify-session-routing-live.ts --live` tests synthetic read/edit/command tool round trips, cold ACP session restoration, model changes, and both directions of native-tool mode switching. It consumes quota and creates server history, but does not execute real commands or edit workspace files. Temporary client session mappings are removed afterward.

`npm run test:commands` requires Bun and exercises command persistence and validation offline with an explicitly isolated state directory. The 0.1.4 live routing check passed both `prefer → disabled` and `disabled → prefer` on cold session resume, including an Argon-to-Flash model change; all observed task tools were `pi_read`, `pi_edit` and `pi_bash`.

`bun scripts/verify-debug-live.ts --live` explicitly tests default-off, on and off again on the same ACP session, using an isolated policy and a synthetic read tool. It checks that tool calls/results and a clearly marked synthetic thought event still reach OMP while debug status visibility follows the switch. It consumes quota and creates server history.

For an explicit live check of outgoing tool-priority instructions, incoming thought events and a synthetic OMP tool round trip, use `bun scripts/diagnose-observability.ts --live --installed` from this source checkout. It consumes quota and creates ACP sessions. See the [2026-10-20 verification report](docs/observability-check-2026-10-20.md), including the corrected diagnosis of an isolated prompt-precedence test.

Before publishing, verify local OMP loading without allowing ACP to start:

```sh
AGY_ACP_BIN=/usr/bin/false omp models antigravity-acp --no-extensions -e ./extension/index.ts --json
```

With no local model cache, upstream's conservative fallback may list fewer models. Listing a model is not proof of account entitlement or successful inference.

The original local implementation also passed live Argon/Flash inference, effort-selector and OMP tool round-trip checks. The planning lifecycle fix passed a live Argon Medium request, session shutdown and a subsequent request with conversation history. Those tests do not cover every platform or the complete interactive Refine plan UI.

The generic catalog implementation passed a live refresh and Argon Low/High inference. Claude, GPT-OSS and future IDs are covered by offline catalog/selector fixtures; live inference for those models remains unverified until the ACP server advertises them.

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Upstream source is vendored under `extension/vendor/pi-antigravity-acp-provider` (MIT) and kept with attribution. Official Google executables and their licenses are separate.
