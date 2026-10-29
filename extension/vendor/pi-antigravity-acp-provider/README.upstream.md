# pi-antigravity-acp-provider

A first-class [Pi](https://github.com/earendil-works/pi) provider for **Google Antigravity** through its official ACP server.

> **Important:** this package no longer uses `@google/gemini-cli`. The Gemini CLI individual Code Assist login path was retired and is not a supported authentication route. Antigravity/`agy` is the target runtime.

## Features

- Registers `antigravity-acp/*` models backed by Google Antigravity.
- Uses ACP protocol v1 and the official TypeScript SDK.
- Collapses Antigravity's effort-qualified IDs into one entry per model; Pi's Shift+Tab reasoning control selects low/medium/high dynamically.
- Supports Pi streaming, cancellation, usage/quota metadata, lifecycle cleanup, and persisted ACP session restoration across Pi restarts.
- Routes compatible Pi tools through an authenticated loopback MCP bridge; doctor/status names omitted tools and their reasons.
- Supports persisted `default`, `auto-edit`, and `yolo` Antigravity permission modes. The requested default is `yolo`; switching to a prompting mode retains the single-use, fail-closed Pi permission broker.
- Advertises no ACP filesystem or terminal client capabilities.
- Provides setup, auth-health, logout/account-switching, qualification, quota, and runtime-update commands.
- Automatically checks for newer managed ACP runtimes once per day, with `automatic`, `notify`, and `manual` update modes.
- Uses an Ed25519-signed runtime catalog with exact Google artifact URLs, archive hashes and sizes, strict two-file extraction, pre-activation ACP identity/version validation, immutable releases, rollback retention, musl rejection, macOS quarantine cleanup, and Windows process-tree handling.

## New-user setup

Install from the official Pi package gallery/npm:

```bash
pi install npm:pi-antigravity-acp-provider
pi
```

To run from source instead:

```bash
git clone https://github.com/zacbemis/pi-antigravity-acp-provider.git
cd pi-antigravity-acp-provider
npm install
pi --no-extensions -e ./extensions/index.ts
```

In Pi:

1. Optionally run `/antigravity-acp setup` for a runtime/auth preflight.
2. Run `/login`.
3. Choose **Sign in with an account**.
4. Choose **Google Antigravity (ACP)**.
5. If needed, wait for the official ACP server download and extraction. Progress is shown; the Linux build observed during development expands to about 1.8 GB.
6. Complete the Google login in the browser.
7. Run `/antigravity-acp setup` again to perform a network auth probe and model discovery.
8. Run `/model` and select one of the `antigravity-acp` models.
9. Press **Shift+Tab** to choose the reasoning effort. Only tiers advertised by Antigravity are exposed. A model with a single tier (for example Argon Medium during rollout) remains a reasoning model with that tier; the provider does not invent Low/High variants.
10. Send a prompt. The default permission mode is `yolo`, so Antigravity-native commands and edits can run without confirmation.

The provider first looks at `AGY_ACP_BIN`, then its verified managed `~/.local/opt/agy-acp/current/` release, `~/.local/bin/agy_acp_server.par`, and `PATH`. Set `AGY_ACP_BIN` to explicitly prefer an externally managed runtime. If absent, it installs the platform build published in the ACP registry. A global `agy` or `gemini` command is not required.

Loopback MCP traffic is exempted from proxies in the ACP child environment. Explicit `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (and lowercase variants) are preserved. On macOS, when none are explicitly set, the provider probes enabled system HTTP proxy settings to avoid automatic SOCKS selection unsupported by the bundled Python runtime. Set `PI_ANTIGRAVITY_ACP_PROXY` to an absolute HTTP/HTTPS proxy URL to explicitly override child proxy settings; the provider does not log the override or change its parent environment. Existing `NO_PROXY` lists and TLS certificate overrides are retained.

Standalone Pi builds also need Node.js to run the ACP supervisor. The provider looks for `node` or `nodejs` on `PATH`; set `NODE` to the executable path if neither is available. On NixOS with Home Manager, `programs.pi-coding-agent.extraPackages = [ pkgs.nodejs ];` adds Node to Pi's `PATH`. An explicit `SSL_CERT_FILE` is preserved; otherwise the provider uses `NIX_SSL_CERT_FILE` or a readable system CA bundle when available.

### SSH and headless Google login

When Pi is running over SSH, or on Linux without `DISPLAY`/`WAYLAND_DISPLAY`, `/login` automatically uses a manual browser relay:

1. Pi prints the Google authorization URL instead of trying to launch a browser on the server.
2. Open that URL in a browser on your local machine and finish Google sign-in.
3. Google redirects to an Antigravity loopback URL. The page may show a connection error because `127.0.0.1` refers to your local machine; copy the **complete final URL** from the browser address bar.
4. Paste that URL into Pi. The provider validates its host, port, path, and OAuth state, then relays it to Antigravity's loopback listener on the server. An SSH port-forward is not required.

Set `PI_ANTIGRAVITY_ACP_OAUTH_MODE=manual` to force this flow, or `PI_ANTIGRAVITY_ACP_OAUTH_MODE=browser` to force normal browser launch. OAuth URLs and callback codes are kept in a private temporary directory only for the duration of login and are never logged or persisted by this package.

For API-key authentication, choose **Enter an API key** and then **Antigravity Gemini API key** in `/login`, or set `GEMINI_API_KEY` before starting Pi.

Antigravity owns OAuth tokens under `~/.gemini/antigravity-acp/`; Pi stores only a non-secret configured marker. Existing `agy` CLI credentials and Gemini CLI credentials should not be assumed to authenticate this separate ACP server.

### Model availability

The model catalog comes from the official ACP server. A successful model listing or selection is not an inference/access probe: newly listed models can still fail because of plan eligibility, staged rollout, or backend availability. As of October 13, 2026, Google's [Argon announcement](https://www.antigravity.google/blog/gemini-4-argon-in-google-antigravity) and [model availability table](https://www.antigravity.google/docs/models/) list Gemini 4 Argon for Google AI Ultra and eligible Enterprise subscriptions, not AI Pro. If it returns `Requested entity was not found`, check access in the official Antigravity app/CLI with the same account; do not guess alternate model IDs or assume the listing proves access. Use another advertised model while investigating.

### macOS credential storage

On macOS the Antigravity server keeps the consumer token in the login keychain (service `gemini`, account `antigravity-acp`) and uses the 0600 file `~/.gemini/antigravity-acp/acp_token.json` only when that keychain is unusable. A keychain that is empty while a refreshable token file exists therefore leaves the server with no credentials it can see: every new ACP server process reports `Credentials missing or invalid`, opens interactive Google consent (which forces the consent screen on every process), and can exceed the session-setup deadline. This provider detects exactly that mismatch and pins the child to the secure-file backend it inspects, so the saved login is reused. Set `AGY_ACP_FORCE_FILE_STORAGE` yourself to take full control of the choice. `doctor`/`status` reports the expected backend as `Credential storage (preflight):`, since the running server's own functional probe can still fall back to the file store. An explicit `GEMINI_HOME` relocates the whole tree, including the token file, and is honored by setup, health checks, logout, and the credential-storage decision.

## Commands

```text
/antigravity-acp setup
/antigravity-acp doctor
/antigravity-acp doctor --verbose
/antigravity-acp status
/antigravity-acp quota
/antigravity-acp update
/antigravity-acp updates [automatic|notify|manual]
/antigravity-acp qualify
/antigravity-acp logout
/antigravity-acp account
/antigravity-acp permissions
/antigravity-acp permissions default
/antigravity-acp permissions auto-edit
/antigravity-acp permissions yolo
```

Permission and runtime-update modes are saved in `$PI_CODING_AGENT_DIR/antigravity-acp-provider/config.json` (where `PI_CODING_AGENT_DIR` defaults to `~/.pi/agent`). Runtime updates default to `automatic`; only provider-managed installations are replaced. ACP session bindings are saved beside the config in `sessions.json`.

On first use of a custom profile without a config, existing permission/update settings are copied from the default agent directory (or the legacy Gemini-provider config). Existing custom configs are never overwritten, and saved sessions are not copied. **Custom Pi profiles do not isolate Antigravity accounts or managed runtimes:** Antigravity's OAuth credentials and runtime installation remain in their shared locations.

`logout`/`account` clears local Antigravity credentials and saved ACP sessions. Run Pi's `/logout` afterward to remove the Pi credential marker, then `/login` for the new account. `update` checks the official registry and installs its newest release only after matching it to the provider's signed runtime catalog. See [`docs/RUNTIME-UPDATES.md`](docs/RUNTIME-UPDATES.md).

## Development

```bash
npm run check
npm run test:real-acp  # initializes the installed Antigravity ACP server
npm run test:live      # sends a real authenticated prompt
npm run test:qualify   # live cancel, restore, MCP, model, and permission qualification
npm run test:packed
npm audit --audit-level=moderate

# Maintainer-only runtime catalog refresh/signing
npm run refresh:runtime-manifest
ACP_RUNTIME_MANIFEST_PRIVATE_KEY_PATH=/secure/key.pem npm run sign:runtime-manifest
```

CI checks Node 22.19.0 and 24, including typechecking, unit tests, packed installation and the full dependency audit. Live authenticated tests are opt-in and are not part of PR CI. See [`docs/MAINTENANCE.md`](docs/MAINTENANCE.md) for update and release policy.

### Turn progress and recovery

Prompts are bounded by inactivity, not total turn duration: streaming progress resets a 10-minute idle window. An outstanding native tool, parked Pi tool, or permission request gets a **finite 60-minute no-progress window** instead, so long work survives the former two-minute Pi-tool deadline without making stuck tools wait forever. Cancellation still sends `session/cancel`, answers parked requests, and closes an unresponsive agent after its 1.5-second grace period. The interactive permission broker retains its two-minute response limit. Integrations can override `promptIdleTimeoutMs` and `promptWorkIdleTimeoutMs` in connection options with positive finite durations; initialize/auth/session-setup deadlines are unchanged.

System instructions are kept outside truncated conversation history. Instructions larger than 256 KiB UTF-8 fail clearly rather than being silently shortened. ACP has no mid-prompt system-update RPC: an instruction change received with tool/permission results finishes the existing prompt under its original instructions, then forces reconstruction before the next prompt. Such a stale binding is not persisted for restoration.

## Security boundary

This launches a full coding agent with the user's OS privileges. **The default `yolo` mode permits Antigravity-native commands and edits without confirmation.** Use `/antigravity-acp permissions default` for confirmation prompts. Disabling ACP filesystem/terminal **client callbacks is not a sandbox** for Antigravity-native tools. Pi hooks govern tools routed through the `pi_` MCP namespace; Antigravity-native tools remain governed by Antigravity policy and ACP permission requests. New/restored sessions must advertise and confirm the requested permission mode. Unsupported or failed mode changes close affected sessions; an executing turn is stopped before changing its policy. Unexpected mode-change notifications also invalidate the session. Doctor/status distinguishes requested policy from each live binding's confirmed mode. This protocol enforcement is not a sandbox.

## Compatibility

This release requires Pi 1.1.x and Node.js 22.19.0 or newer; development is pinned to Pi 1.1.0, ACP SDK 1.8.0, and ACP protocol 1. The provider supports stable session configuration options and retains compatibility with older Antigravity model-selection metadata; it does not enable experimental ACP v2. Upgrade Pi before upgrading from provider 0.1.12. Pi supplies the host packages at runtime, so their peer ranges remain `*` as required by Pi's package contract; this is not a promise of compatibility with every Pi version. Transcript system instructions and tool additions/removals are replayed into ACP checkpoints, replacing stale warm sessions when that state changes. The bundled signed catalog bootstraps Antigravity ACP 1.1.1 and can accept newer signed catalog releases without an npm update. ACP session setup allows up to two minutes for slow first-run initialization, while transport shutdown rejects pending requests immediately. The current official registry and signed catalog provide Linux x64/ARM64, Windows x64/ARM64, and macOS Intel/ARM64 artifacts. Intel macOS artifacts exist, but the proposed local re-signing workaround is not enabled or qualified by this package. Alpine/musl is rejected because Google's Linux build targets glibc.

During browser authentication, Chromium may write `Opening in existing browser session.` to the ACP process's inherited stdout. The transport ignores only that exact known compatibility line and reports its count in `doctor`; all other non-JSON stdout remains a fatal protocol error.

Managed installations also repair executable permissions for both the ACP server and its `localharness_external` helper. This repairs installations created by 0.1.3 and earlier, where OAuth could succeed but session creation failed with an opaque ACP `Internal error` because the extracted helper was not executable.

Earlier repository documents analyzing `@google/gemini-cli@0.58.0` describe the superseded implementation and are retained only as historical research. See [`docs/ANTIGRAVITY-MIGRATION.md`](docs/ANTIGRAVITY-MIGRATION.md).

## License

MIT
