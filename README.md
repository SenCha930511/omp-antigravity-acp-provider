# omp-antigravity-acp-provider

[![npm version](https://img.shields.io/npm/v/omp-antigravity-acp-provider.svg)](https://www.npmjs.com/package/omp-antigravity-acp-provider)
[![npm downloads](https://img.shields.io/npm/dm/omp-antigravity-acp-provider.svg)](https://www.npmjs.com/package/omp-antigravity-acp-provider)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=node.js&logoColor=white)](package.json)
[![OMP marketplace](https://img.shields.io/badge/OMP-marketplace-7c3aed)](https://github.com/SenCha930511/omp-antigravity-acp-provider)
[![ACP runtime](https://img.shields.io/badge/ACP%20runtime-%E2%89%A51.4.1-4285F4)](https://github.com/SenCha930511/omp-antigravity-acp-provider)
[![GitHub stars](https://img.shields.io/github/stars/SenCha930511/omp-antigravity-acp-provider)](https://github.com/SenCha930511/omp-antigravity-acp-provider/stargazers)

Google Antigravity's official ACP server, adapted for **Oh My Pi (OMP)**.

**An OMP-focused derivative fork of [zacbemis/pi-antigravity-acp-provider](https://github.com/zacbemis/pi-antigravity-acp-provider).** Original project by [zacbemis](https://github.com/zacbemis) and contributors, licensed under MIT.

This is an independent adaptation, **NOT** an official Google or OMP integration. It uses ACP over stdio. The local HTTP MCP bridge carries tool calls; it is not a model API reverse proxy.

## Features

- All server-advertised models, including Claude, GPT-OSS and future IDs when the ACP endpoint advertises them.
- CLI-first selection. When a usable `agy` CLI is on `PATH`, the adapter launches it through a generated `AGY_ACP_BIN` wrapper. The managed runtime is the fallback. An explicit `AGY_ACP_BIN` always wins.
- Per-model thinking levels, exposed only when the server confirms them.
- OMP tools through an authenticated loopback MCP bridge.
- Optional `disabled` native-tool mode for strict OMP-only sessions.
- Lazy ACP startup and warm session reuse.
- `/login` plus `/antigravity-acp` account, usage and cleanup commands.
- API-equivalent cost estimates from a model-ID rate table, not subscription billing. ACP model records do not include price fields.
- Long-running OMP tools survive the MCP request window through a relay. The model resumes the same result with `pi_omp_await_result`; the control tool is a separate MCP server and never appears in OMP's tool list.
- Permission requests are tied to the originating session, turn and tool call. Forged, conflicting or previous-turn identities fail closed, while normal requests still use OMP's human review.
- The MCP `tools/list` reflects the current OMP tool set. The offline wire test covers add, remove and restore on one warm ACP session.
- Tool-argument hardening on the MCP bridge. Habitual alias mistakes such as `path` for `file_path` are corrected only when the tool schema makes the mapping unambiguous, and rejected calls return the missing required keys plus the tool's expected signature instead of a bare schema failure.
- Loopback traffic always bypasses proxied environments. When `HTTP(S)_PROXY` or `ALL_PROXY` is set for the ACP child process, the adapter appends `localhost`, `127.0.0.1` and `::1` to `NO_PROXY`/`no_proxy` so the loopback MCP bridge is never routed through an external proxy.
- OAuth material is redacted from failure text. Authorization URLs, sensitive query values, `Bearer` tokens and OAuth pairs such as `code_challenge` or `access_token` are masked before messages reach OMP, while ordinary diagnostics like `exit code=1` stay intact.

## Supported platforms

The adapter is a Node.js OMP plugin. The table lists the configuration each platform accepts and the validation actually performed, not a promise that every path has been run on every system.

| Platform | Configuration | Validation |
| --- | --- | --- |
| macOS on arm64 | `agy` on `PATH`, an explicit `AGY_ACP_BIN`, or the managed runtime in `~/.local/opt/agy-acp/`. Keychain lookups use `/usr/bin/security`. | Live: Gemini inference, MCP tools, steering, cancellation and continuation, local plugin linking. |
| Linux | `agy` on `PATH`, an explicit `AGY_ACP_BIN`, or the managed runtime. Secret Service items are inspected and removed with `secret-tool` from libsecret. | Offline tests with synthetic fixtures. No live Linux run in this environment. |
| Windows | `agy.exe` on `PATH`, an explicit `AGY_ACP_BIN` pointing at your ACP command, or the generated `.cmd` wrapper. | Configuration only. The supervisor wrapper and the full managed-runtime download have not been run on Windows. |

### Credentials and keyrings

Google browser consent works on every platform. The ACP server stores the result in its own credential store, and the adapter checks the same store for login readiness and logout.

- **macOS.** The adapter checks the login keychain item `gemini` / `antigravity-acp` with `/usr/bin/security`. The attribute-only lookup does not prompt for the keychain password. Logout removes that item. Keychain-stored tokens expose no account email, so `account` shows the address only when a token file exists.
- **Linux.** Secret Service holds the same item as `service=gemini`, `username=antigravity`. The adapter needs `secret-tool` from libsecret to detect or delete it; install it from your distribution's libsecret package. A confirmed missing item is distinct from an unavailable or locked backend. Without `secret-tool`, the backend's state cannot be confirmed. Login readiness falls back to the token file under `~/.gemini/antigravity-acp/` and to `GEMINI_API_KEY`. A login that exists only in Secret Service is not detected in that state, while token-file and API-key inference still work.
- **Windows.** There is no keyring integration. The token file and `GEMINI_API_KEY` are supported credential sources.

On Windows, CLI discovery searches for `agy` and `agy.exe`. Set `AGY_ACP_BIN` explicitly for an npm-generated `.cmd` shim. The `.cmd` supervisor wrapper has not been exercised on Windows.

## Install: for human

Follow these steps in order. The whole flow takes a few minutes, plus Google's sign-in. A runtime download is only needed when no usable `agy` CLI is installed.

### 1. Check prerequisites

- OMP is installed and `omp --version` works.
- Node.js 22.19 or newer (`node --version`) and npm are on `PATH`; the marketplace launcher uses them on first load.
- A supported platform: macOS, Linux or Windows. [Supported platforms](#supported-platforms) lists what each one accepts and what has been validated.
- Internet access when no usable `agy` CLI is installed. The managed fallback downloads separately (about 383 MiB on macOS) into `~/.local/opt/agy-acp/`.

### 2. Install exactly one adapter

Use the marketplace (this repository is also the **sencha-plugins** marketplace):

```sh
omp plugin marketplace add SenCha930511/omp-antigravity-acp-provider
omp plugin install omp-antigravity-acp-provider@sencha-plugins
```

Or install the published npm package directly:

```sh
omp plugin install npm:omp-antigravity-acp-provider
```

Do not install both. Remove or disable any older Antigravity ACP adapter first.

### 3. Restart OMP

The provider registers at startup. Restart every running OMP process so they agree on session ownership.

### 4. Sign in

Run `/login`, choose **Google Antigravity (ACP)**, and complete Google's consent in the browser. On a headless machine the provider relays the callback URL. Alternatively, add the **Antigravity Gemini API key** method in `/login` and paste a Gemini API key, or export `GEMINI_API_KEY` before starting OMP. On Linux, keyring requirements are covered under [Supported platforms](#supported-platforms).

### 5. Load models and pick one

```text
/antigravity-acp refresh
/model
```

`refresh` asks the ACP server which models the account can use; `/model` lists them. Set an effort with OMP's thinking control when the model advertises levels. If OMP's `enabledModels` whitelist is configured, add `antigravity-acp/*` to it.

### 6. Verify

```text
/antigravity-acp status
```

This shows the runtime, native-tool mode and usage state. Send a short prompt to confirm inference.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| `omp: command not found` | This is an OMP plugin. Install OMP first; there is no standalone CLI. |
| No models after `/antigravity-acp refresh` | Run `/antigravity-acp account` to confirm both sides are signed in, then retry with internet access. ACP can advertise fewer models than the Antigravity app. |
| Two Antigravity providers appear | Remove the older adapter (`antigravity-acp-omp`, the upstream Pi extension, or a duplicate npm install), then restart OMP. |
| Login opens the wrong Google account | Both login paths always start a fresh sign-in. Choose the intended account (or "Use another account") on Google's consent screen. |
| `disabled` native-tool mode rejects the session | The official runtime must advertise system-append support (1.4.1+). Upgrade the runtime or run `/antigravity-acp native-tools prefer`. |
| The first request is slow | Runtime download and cold ACP start happen once; later turns reuse the warm session. |
| A tool call returns a relay notice | The model should call `pi_omp_await_result` with the notice's `call_id`. Lower `OMP_ACP_TOOL_RELAY_MS` or set it to `0` to disable relay. |

## Install: for agents

The installation runbook is in [AGENT_INSTALL.md](AGENT_INSTALL.md). Hand that file to an agent with terminal access; it installs and verifies the adapter without starting an interactive login. For example: `Read AGENT_INSTALL.md and follow it.`

## ACP server channels and selection

Google ships the same ACP server through two channels. The adapter chooses one at every OMP startup.

- **`agy` CLI.** Preferred whenever `agy` or `agy.exe` is on `PATH` and `agy acp --version` returns a semantic version. The adapter writes `agy-acp-cli.sh` or `agy-acp-cli.cmd` and points `AGY_ACP_BIN` at that wrapper.
- **Managed runtime.** The registry-signed release in `~/.local/opt/agy-acp/`. It is the fallback when the CLI is missing or unusable.

Selection order:

1. An explicit non-wrapper `AGY_ACP_BIN` wins. The adapter's generated wrapper is not a user override.
2. If `runtimeSource` is `cli` or `managed`, the adapter uses that source exclusively. A missing pinned source fails the first ACP use and is not downloaded.
3. If `runtimeSource` is `auto`, a usable CLI wins, even when its version is older than the managed runtime.
4. In `auto`, if the CLI is missing or unusable, the adapter uses the managed runtime. If the managed runtime is missing, it downloads it from Google's registry.
5. In `auto`, if writing the CLI wrapper or runtime record fails, the adapter falls back to the managed runtime.

The adapter never installs the `agy` CLI. It downloads the managed runtime only in `auto` when no usable CLI is selected. Inference and quota use the same selection.

On the first session start after OMP launches, the adapter attempts one background model refresh. A successful refresh re-registers the provider so newly advertised models and their API-equivalent rates become available. If login or ACP startup fails, the cached catalog remains usable and `/antigravity-acp refresh` still forces a refresh.

Create or edit `~/.omp/agent/antigravity-acp-provider/config.json`:

```json
{
  "permissions": "yolo",
  "runtimeSource": "auto",
  "nativeTools": "prefer",
  "debugToolUpdates": false,
  "usageMode": "off",
  "diagnostics": false
}
```

`permissions` accepts `default`, `auto_edit`, or `yolo`. `runtimeSource` accepts `auto`, `cli`, or `managed`. `nativeTools` accepts `prefer` or `disabled`. `usageMode` accepts `auto` or `off`. `debugToolUpdates` and `diagnostics` are config-only booleans. Missing fields use these defaults: `permissions: "yolo"`, `runtimeSource: "auto"`, `nativeTools: "prefer"`, `debugToolUpdates: false`, `usageMode: "off"`, and `diagnostics: false`. Slash commands write the command-backed fields and keep the legacy setting files in sync. Context budgets remain in `context.json`; cleanup policy remains in `cleanup.json`.

- `auto` uses the CLI first and falls back to the managed runtime. If no usable CLI exists, it downloads the managed runtime.
- `cli` requires a usable `agy` CLI. If the CLI is missing or unusable, the first ACP use fails and nothing is downloaded.
- `managed` requires the managed runtime. If it is missing, the first ACP use fails and nothing is downloaded.

A pinned source never falls back to the other channel and never downloads it. An explicit non-wrapper `AGY_ACP_BIN` still wins over this setting. If `PI_CODING_AGENT_DIR` is set, use its actual path for `config.json`. Other `runtimeSource` values fail provider startup.

Session storage follows the server's own `--app_data_dir`. The generated wrapper pins `antigravity-acp` — the managed runtime's own default — so CLI-launched ACP sessions land in `~/.gemini/antigravity-acp/`, where `/antigravity-acp cleanup` and session ownership tracking operate. Personal `agy` CLI chats stay in `~/.gemini/antigravity-cli/` and are never read or deleted by the adapter. `GEMINI_HOME` relocates the managed runtime's tree (upstream behavior); the `agy` CLI stores under `~/.gemini` regardless.

The active channel and its versions are recorded in `~/.omp/agent/antigravity-acp-provider/acp-runtime-source.json` whenever the CLI is chosen.

Permission IDs differ between the channels. Managed ACP 1.4.5 supports `default`, `auto_edit`, and `yolo` directly. CLI ACP 1.5.3 advertises `default`, `accept-edits`, and `plan` instead. The adapter maps `auto-edit` to `accept-edits`. For `yolo`, it selects wire mode `default` and passes the CLI's official `--dangerously-skip-permissions` flag. This preserves auto-approval instead of substituting `accept-edits`. Changing permission modes recreates the ACP runtime so a process with auto-approval cannot serve a later `default` or `auto-edit` request. An explicit `AGY_ACP_BIN` is left unchanged.

CLI ACP 1.5.3 omits `mcpCapabilities` from its initialization response, but it still discovers HTTP MCP servers and calls `tools/list`. The adapter normalizes this capability for that server identity so OMP tools remain available. CLI 1.5.3 reports no audio input, while the adapter's model catalog already limits input to text and images.

### Context occupancy and compaction

ACP may report live occupancy with `usage_update`. When it does, the adapter forwards that server value. When a runtime (for example CLI ACP 1.5.4) reports only cumulative billable usage, the adapter estimates the full OMP context from the system prompt, retained messages and tool schemas with `estimateTransferTokens`, then sets `usage.contextTokens` and marks `contextTokensSource: "estimate"`. The billable `input`, `cacheRead` and `output` counters are left untouched.

The estimate is a heuristic, not a server measurement. To use managed ACP when exact occupancy matters, set `AGY_ACP_BIN` to the managed binary. CLI-first selection does not switch automatically. In this source checkout, `scripts/with-managed-context.sh` starts OMP with the installed managed binary while preserving an explicit `AGY_ACP_BIN`. Run `/antigravity-acp refresh` afterward to inspect the models that runtime actually advertises.

Keep `compaction.autoContinue` enabled for normal long-running work. The false context rollover was fixed at the occupancy signal, not by disabling automatic continuation.

## Commands

Use the `/antigravity-acp ` prefix once, followed by a row below. For example, `status` means `/antigravity-acp status`.

### Common operations

| Subcommand | Purpose |
| --- | --- |
| *(none)* or `status` | Show login readiness, negotiated runtime/native channel when available, permission policy, native tools, non-empty usage records and active sessions. Requested and wire permissions share one row when they differ. Empty process details are omitted; runtime/API warnings remain visible. |
| `account` | Show the signed-in account, ACP authentication and non-secret OMP marker. Token ownership, logout behavior and account/store inconsistencies are not hidden. |
| `login` | Start a fresh Google authorization. |
| `logout` | Clear Antigravity credentials, saved sessions and the OMP marker. |
| `refresh` | Discover and cache advertised models, then list the refreshed IDs. |
| `usage` | Show configured → effective supplemental-query mode (`OMP_ACP_USAGE=off` forces `off`) and only populated per-connection context, compaction and accounting details. |
| `usage auto` | Query supplemental usage after each reply. Context occupancy updates remain enabled. |
| `usage off` | Skip supplemental queries without disabling context occupancy updates. |

Quota results use a 60-second cache. When the adapter selects the CLI, the automatic quota query runs the CLI's print-mode `/usage` command with the same `--app_data_dir` as the CLI ACP wrapper. When it selects managed ACP, the query uses a short-lived ACP session. An explicit `AGY_ACP_BIN` remains authoritative. If an ACP runtime does not advertise `usage`, the adapter reports the limitation without sending a model prompt. Usage counters from temporary ACP sessions are excluded.

OMP's built-in `omp usage`, interactive `/usage`, and the statusline `usage` segment read the same quota through the provider's registered usage source. The adapter uses the CLI `/usage` command first and queries an installed managed runtime only when the user is signed in. A usage probe never downloads a runtime. Statusline selects the active model's limit group when that group maps to one model. Multi-model groups remain visible in `/usage`.

### Advanced maintenance

| Subcommand and options | Purpose |
| --- | --- |
| `context` | Show saved shared defaults separately from each cached model's effective limits and model-only overrides. Effective values include the input, output, reserve, transfer and image budgets used by runtime compatibility checks. |
| `context set default KEY NUMBER` | Change a shared numeric context setting. |
| `context set MODEL KEY NUMBER` | Change one model override. Reselect the model or restart OMP to refresh its displayed limits. |
| `context set default usageMode auto\|off` | Equivalent to `usage auto\|off`. |
| `cleanup` | Collect using the saved policy and show its mode, retention, non-empty session counts, actual removals, warnings and state-loss risk. |
| `cleanup off` | Keep every saved session. |
| `cleanup conservative` | Remove only eligible idle, unmapped sessions while preserving mapped history and live leases. |
| `cleanup timeout [DAYS]` | Apply timeout collection, optionally with a custom idle retention in days. |
| `cleanup balanced [DAYS]` | Apply timeout and soft-budget cleanup with recovery protection, optionally with custom idle days. |
| `cleanup budget MAX_SESSIONS MAX_MIB` | Set soft session/byte limits; `0` disables either limit. Active and recently used sessions can remain above a soft budget. Timeout deletion loses ACP-only state but retains OMP history. |
| `native-tools prefer` | Let OMP tools shadow matching ACP-native tools. |
| `native-tools disabled` | Disable ACP-native built-ins for strict OMP-tool sessions while retaining MCP configuration; connections are recreated on the next request. |
| `permissions default` | Confirm edits and commands. |
| `permissions auto-edit` | Auto-accept edits. |
| `permissions yolo` | Auto-accept everything; changing modes recreates runtimes to avoid reusing an unsafe process. |

Context `KEY` is one of `contextWindow`, `maxTokens`, `inputTokenBudget`, `reserveTokens`, `maxTransferBytes` or `maxImageBytes`.

The OMP input autocompletes this command. Type `/antigravity-acp ` to list the subcommands, and keep typing to filter them. Fixed values such as `permissions` modes and `context set` targets (default plus the cached model IDs) complete the same way.

## Steering and queued messages

By default a new user message waits for the active ACP turn to finish (`OMP_ACP_STEER_MODE=queue`) and then continues on the warm session, avoiding a full replay and OMP auto-compaction. Set `OMP_ACP_STEER_MODE=steer` to restore immediate interruption. At tool/permission boundaries the adapter falls back to steer and waits for the ACP terminal response; `OMP_ACP_STEER_GRACE_MS` (default 60000) and `OMP_ACP_STEER_GRACE_MAX_MS` (default 300000) bound that wait. Explicit user cancellation is never held: the adapter aborts the upstream prompt immediately, so the ACP server receives `session/cancel` at once. Queue steering still holds the active turn, and the graceful drain and checkpoint reuse semantics are unchanged.

ACP runtimes stay warm for 15 minutes by default. Set `OMP_ACP_IDLE_TIMEOUT_MS=0` to keep them until OMP exits, or lower the value to reclaim memory sooner.

An ACP turn that ends at the model's output limit is continued on the same session up to three times. `OMP_ACP_MAX_CONTINUATIONS=0` disables the loop; if agy already reported its own output-cap continuation, the adapter does not add another.

Inference and `/antigravity-acp refresh` refuse to start ACP when no local Google login is available; run `/login` (or `/antigravity-acp login`) first instead of waiting for an interactive consent flow inside `session/new`.

## Long tools and relay

A tool call that outlives `OMP_ACP_TOOL_RELAY_MS` (default 85000, `0` disables, otherwise 5000 through 165000) returns a relay notice instead of holding the MCP request open. The model calls `pi_omp_await_result` with the notice's `call_id`; the adapter returns the same original result, not a second execution. The control tool is a separate MCP server and is not added to OMP's tool list. If the ACP turn ends before the result arrives, the adapter retries the same result in a fresh ACP turn; it never delivers a stale result to a new writer.

Permission requests are correlated by session, turn and `toolCallId` with structured `mcpServerName`/`mcpToolName` metadata. A conflicting update, a previous-turn id, or a permission-before-update that claims MCP identity is rejected with `reject_once` when available, otherwise `cancelled`. Normal requests still go through OMP's human review.

The bridge's MCP `tools/list` always reflects the current OMP tool set. The offline wire test covers add, remove and restore on one warm ACP session. A live agent re-list has not been verified against the official agy runtime, so the adapter does not claim that the agent will always see a changed list.

A `refusal` stop reason is reported as an explicit provider refusal. An empty `end_turn` remains tolerated to preserve OMP's warm `/retry` path.


## Limitations vs direct OAuth

- No direct model API endpoint or reverse-proxy mode.
- Credentials come from the ACP server's own stores: Google browser consent, `GEMINI_API_KEY`, or a Gemini API key saved in OMP's auth store. Raw OAuth tokens supplied by hand and service accounts are not accepted. Keyring access is limited to what the adapter can inspect; see [Supported platforms](#supported-platforms).
- Usage and quota through a key saved in OMP's auth store can be incomplete, because the host usage provider is not passed that credential.
- Only models advertised by the ACP server are available.
- Only thinking levels confirmed by the ACP server are selectable.
- No arbitrary generation controls: temperature, top_p, seed, stop sequences, tool_choice, response format, or output-token limit.
- No exact API billing or complete subagent usage; cost and quota figures are estimates.
- No guaranteed prompt-cache hits, cache discounts, or identical tokenization.
- No full native history or hidden reasoning across a cold rebuild; server-side compaction is outside adapter control.
- No per-tool native allowlist; `native-tools` supports only `prefer` and `disabled`, and global MCP servers remain.
- No standalone client; a usable ACP server, either the `agy` CLI or the managed runtime, is required.

Detailed behavior, advanced settings and limitations: [docs/](docs/) and [CHANGELOG.md](CHANGELOG.md).

## Contributors

The Linux Secret Service credential handling is adapted from [Maddock (@notmaddock)](https://github.com/notmaddock)'s work in [PR #2](https://github.com/SenCha930511/omp-antigravity-acp-provider/pull/2). Upstream project attribution stays in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

GitHub counts a contributor when a commit that credits them, as author or through a `Co-authored-by:` trailer, reaches the default branch ([contributor list](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-a-projects-contributors), [co-authored commits](https://docs.github.com/en/pull-requests/how-tos/commit-changes/creating-a-commit-with-multiple-authors)). Until commits carrying that credit are on the default branch of the public repository, its contributors page will not list the addition.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Upstream 0.1.15 code is incorporated into the owned runtime sources under `extension/runtime/` (MIT) and kept with attribution. Official Google executables and their licenses are separate.
