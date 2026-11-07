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
- Per-model thinking levels, exposed only when the server confirms them.
- OMP tools through an authenticated loopback MCP bridge.
- Optional `disabled` native-tool mode for strict OMP-only sessions.
- Lazy ACP startup and warm session reuse.
- `/login` plus `/antigravity-acp` account, usage and cleanup commands.
- API-equivalent cost estimates, not subscription billing.

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

## Install: for agents

The installation runbook is in [AGENT_INSTALL.md](AGENT_INSTALL.md). Hand that file to an agent with terminal access; it installs and verifies the adapter without starting an interactive login. For example: `Read AGENT_INSTALL.md and follow it.`

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
| `/antigravity-acp native-tools prefer\|disabled` | Native built-in tool policy |
| `/antigravity-acp tools` | Available and omitted OMP tool schemas |
| `/antigravity-acp debug on\|off` | ACP tool-status lines |
| `/antigravity-acp permissions default\|auto-edit\|yolo` | Permission mode |

Supplemental `/usage` queries are off by default. Context occupancy still comes from ACP `usage_update`. Run `/antigravity-acp usage auto` to opt into the extra query.

## Steering and queued messages

By default a new user message waits for the active ACP turn to finish (`OMP_ACP_STEER_MODE=queue`) and then continues on the warm session, avoiding a full replay and OMP auto-compaction. Set `OMP_ACP_STEER_MODE=steer` to restore immediate interruption. At tool/permission boundaries the adapter falls back to steer and waits for the ACP terminal response; `OMP_ACP_STEER_GRACE_MS` (default 60000) and `OMP_ACP_STEER_GRACE_MAX_MS` (default 300000) bound that wait.

ACP runtimes stay warm for 15 minutes by default. Set `OMP_ACP_IDLE_TIMEOUT_MS=0` to keep them until OMP exits, or lower the value to reclaim memory sooner.

An ACP turn that ends at the model's output limit is continued on the same session up to three times. `OMP_ACP_MAX_CONTINUATIONS=0` disables the loop; if agy already reported its own output-cap continuation, the adapter does not add another.

Inference and `/antigravity-acp refresh` refuse to start ACP when no local Google login is available; run `/login` (or `/antigravity-acp login`) first instead of waiting for an interactive consent flow inside `session/new`.

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
