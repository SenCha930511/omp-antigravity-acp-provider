# Install for agents

Hand this file to an agent with terminal access. It installs and verifies the adapter without starting an interactive login.

```text
Install the OMP plugin "omp-antigravity-acp-provider" from https://github.com/SenCha930511/omp-antigravity-acp-provider.

Constraints:
- Do not start a Google login, open a browser, or run any command that waits for user input.
- Do not copy, print, store or transmit credentials, tokens or account identifiers.
- Do not install both the npm and marketplace variants.

Steps:
1. Run `omp --version` and `node --version`. Stop and report if OMP is missing or Node.js is below 22.19.
2. Run `omp plugin list --json` and search `npm[].name` and `marketplace[].id` for `antigravity-acp-provider`. If one exists, stop and report it instead of installing a second copy.
3. Install with `omp plugin install npm:omp-antigravity-acp-provider`. For the marketplace variant, run `omp plugin marketplace add SenCha930511/omp-antigravity-acp-provider` first, then `omp plugin install omp-antigravity-acp-provider@sencha-plugins`.
4. Run `omp plugin list --json` again and confirm exactly one adapter is present. Record its version.
5. Run `omp models antigravity-acp --json`. Cached listing must not start the ACP server. An empty catalog before sign-in is acceptable; report it instead of retrying in a loop.
6. Tell the user to restart OMP, then run `/login` → "Google Antigravity (ACP)" and `/antigravity-acp refresh` inside OMP. Do not perform these steps yourself.

Acceptance: one adapter installed, `omp models antigravity-acp --json` returns valid JSON, and no credential material appears in any output. Report the commands run, the adapter version, any model IDs and the first step that failed.
```
