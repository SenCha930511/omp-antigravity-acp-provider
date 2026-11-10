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
- Newest-server auto-selection. When the `agy` CLI on PATH bundles a newer ACP server than the registry-installed runtime, the adapter launches it through a generated `AGY_ACP_BIN` wrapper, so CLI-first models appear without manual setup. An explicit `AGY_ACP_BIN` always wins.
- Per-model thinking levels, exposed only when the server confirms them.
- OMP tools through an authenticated loopback MCP bridge.
- Optional `disabled` native-tool mode for strict OMP-only sessions.
- Lazy ACP startup and warm session reuse.
- `/login` plus `/antigravity-acp` account, usage and cleanup commands.
- API-equivalent cost estimates, not subscription billing.
- Long-running OMP tools survive the MCP request window through a relay. The model resumes the same result with `pi_omp_await_result`; the control tool is a separate MCP server and never appears in OMP's tool list.
- Permission requests are tied to the originating session, turn and tool call. Forged, conflicting or previous-turn identities fail closed, while normal requests still use OMP's human review.
- The MCP `tools/list` reflects the current OMP tool set. The offline wire test covers add, remove and restore on one warm ACP session.

## Install: for human

Follow these steps in order. The whole flow takes a few minutes, plus Google's sign-in and the first runtime download.

### 1. Check prerequisites

- OMP is installed and `omp --version` works.
- Node.js 22.19 or newer (`node --version`) and npm are on `PATH`; the marketplace launcher uses them on first load.
- A supported platform: macOS, Linux or Windows. Live testing has been on macOS.
- Internet access for the first run. The official Antigravity runtime downloads separately (about 383 MiB on macOS) into `~/.local/opt/agy-acp/`.

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

Run `/login`, choose **Google Antigravity (ACP)**, and complete Google's consent in the browser. On a headless machine the provider relays the callback URL.

On Linux the `agy` CLI stores the OAuth token in the Secret Service keyring (`service=gemini`, `username=antigravity`), not in `acp_token.json`. The adapter reads that item with `secret-tool` when the token file is absent, so install `libsecret-tools` (Fedora: `libsecret`) to make login detection work. `/antigravity-acp logout` and the follow-up to OMP's `/logout` clear the same item.

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

Google ships the same ACP server through two channels; the adapter picks between them automatically at every OMP startup.

- **`agy` CLI** — the self-updating command-line product. When its bundled server is newer than the registry runtime, the adapter launches it through a generated `AGY_ACP_BIN` wrapper, so CLI-first models (for example Claude and GPT-OSS) appear without manual setup.
- **Managed runtime** — the registry-signed release downloaded and verified into `~/.local/opt/agy-acp/`. Used when the CLI is missing or not newer, and installed automatically when neither channel exists.

Selection order:

1. An explicit `AGY_ACP_BIN` always wins. Point it at an `agy acp`-capable executable or wrapper to force a channel.
2. Otherwise the newer server version wins; ties go to the managed runtime.
3. With neither present, the managed runtime is downloaded from Google's registry on next use.

Session storage follows the server's own `--app_data_dir`. The generated wrapper pins `antigravity-acp` — the managed runtime's own default — so CLI-launched ACP sessions land in `~/.gemini/antigravity-acp/`, where `/antigravity-acp cleanup` and session ownership tracking operate. Personal `agy` CLI chats stay in `~/.gemini/antigravity-cli/` and are never read or deleted by the adapter. `GEMINI_HOME` relocates the managed runtime's tree (upstream behavior); the `agy` CLI stores under `~/.gemini` regardless.

The active channel and its versions are recorded in `~/.omp/agent/antigravity-acp-provider/acp-runtime-source.json` whenever the CLI is chosen.

Permission IDs differ between the channels. Managed ACP 1.4.5 supports `default`, `auto_edit`, and `yolo` directly. CLI ACP 1.5.3 advertises `default`, `accept-edits`, and `plan` instead. The adapter maps `auto-edit` to `accept-edits`. For `yolo`, it selects wire mode `default` and passes the CLI's official `--dangerously-skip-permissions` flag. This preserves auto-approval instead of substituting `accept-edits`. Changing permission modes recreates the ACP runtime so a process with auto-approval cannot serve a later `default` or `auto-edit` request. An explicit `AGY_ACP_BIN` is left unchanged.

CLI ACP 1.5.3 omits `mcpCapabilities` from its initialization response, but it still discovers HTTP MCP servers and calls `tools/list`. The adapter normalizes this capability for that server identity so OMP tools remain available. CLI 1.5.3 reports no audio input, while the adapter's model catalog already limits input to text and images.

## Commands

| Command | Purpose |
| --- | --- |
| `/antigravity-acp status` | Runtime, thinking and usage information |
| `/antigravity-acp account` | Signed-in account and authentication state |
| `/antigravity-acp login` | Re-run the Google authorization |
| `/antigravity-acp logout` | Clear Antigravity credentials and saved sessions |
| `/antigravity-acp refresh` | Discover and cache advertised models |
| `/antigravity-acp usage [auto\|off]` | Context occupancy and supplemental usage queries |
| `/antigravity-acp context` | Per-model context budgets |
| `/antigravity-acp cleanup [mode]` | Session-file cleanup policy |
| `/antigravity-acp diagnostics [on\|off\|reset]` | Adapter stage timing samples |
| `/antigravity-acp native-tools prefer\|disabled` | Native built-in tool policy |
| `/antigravity-acp tools` | Available and omitted OMP tool schemas |
| `/antigravity-acp debug on\|off` | ACP tool-status lines |
| `/antigravity-acp permissions default\|auto-edit\|yolo` | Permission mode |

The OMP input autocompletes this command. Type `/antigravity-acp ` to list the subcommands, and keep typing to filter them. Fixed values such as `permissions` modes and `context set` targets (default plus the cached model IDs) complete the same way.

## Steering and queued messages

By default a new user message waits for the active ACP turn to finish (`OMP_ACP_STEER_MODE=queue`) and then continues on the warm session, avoiding a full replay and OMP auto-compaction. Set `OMP_ACP_STEER_MODE=steer` to restore immediate interruption. At tool/permission boundaries the adapter falls back to steer and waits for the ACP terminal response; `OMP_ACP_STEER_GRACE_MS` (default 60000) and `OMP_ACP_STEER_GRACE_MAX_MS` (default 300000) bound that wait.

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
- No API-key, service-account, or raw OAuth-token authentication; Google browser consent is required.
- Only models advertised by the ACP server are available.
- Only thinking levels confirmed by the ACP server are selectable.
- No arbitrary generation controls: temperature, top_p, seed, stop sequences, tool_choice, response format, or output-token limit.
- No exact API billing or complete subagent usage; cost and quota figures are estimates.
- No guaranteed prompt-cache hits, cache discounts, or identical tokenization.
- No full native history or hidden reasoning across a cold rebuild; server-side compaction is outside adapter control.
- No per-tool native allowlist; `native-tools` supports only `prefer` and `disabled`, and global MCP servers remain.
- No standalone client; the official ACP runtime is required.

Detailed behavior, advanced settings and limitations: [docs/](docs/) and [CHANGELOG.md](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Upstream source is vendored under `extension/vendor/pi-antigravity-acp-provider` (MIT) and kept with attribution. Official Google executables and their licenses are separate.
