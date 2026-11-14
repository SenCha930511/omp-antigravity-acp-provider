# Third-party notices

omp-antigravity-acp-provider is an OMP-focused derivative fork/adaptation of [pi-antigravity-acp-provider](https://github.com/zacbemis/pi-antigravity-acp-provider), originally created by [zacbemis](https://github.com/zacbemis) and contributors and distributed under MIT. Upstream 0.1.15 code is incorporated directly into the owned runtime sources under `extension/runtime/` and is kept with attribution; there is no separate vendored copy or upstream package dependency.

The upstream authors retain credit for the original ACP transport, authentication, runtime installation, session restoration and MCP bridge implementation.

Its original license notice follows. The adapter adds OMP-specific registration, model selectors, lifecycle handling, tool-routing instructions and cost estimation. Published npm packages include the generated `THIRD_PARTY_LICENSES.txt` with license notices for bundled dependencies. Google runtime executables are not included.

## Community fork adaptations

The following community work was adapted into the owned adapter architecture rather than merging the pre-refactor source trees. These notices cover adaptation, not endorsement by the contributors or by Google.

- [notmaddock/omp-antigravity-acp-provider](https://github.com/notmaddock/omp-antigravity-acp-provider) (`@notmaddock`): Linux Secret Service authentication and known Claude/GPT-OSS metadata plus offline partner-model fallback.
- [ldfhhc/omp-antigravity-acp-provider](https://github.com/ldfhhc/omp-antigravity-acp-provider) (`@ldfhhc`): oldest-image history continuity and hidden history/request seed guards. The independently guarded implementation lives in `extension/runtime/image-history.ts` and `extension/runtime/history-seed.ts`.
- [00lllooolll00/omp-antigravity-acp-provider](https://github.com/00lllooolll00/omp-antigravity-acp-provider) (`@00lllooolll00`): fresh-login watcher protection, Hydrogen/offline catalog discovery, Bun SQLite usage, CLI stat caching, quota refresh grace, standby warmup and release helper ideas, adapted and additionally hardened in this repository.
- [masred/omp-antigravity-acp-provider](https://github.com/masred/omp-antigravity-acp-provider) (`@masred`): standard Google OAuth endpoints and AccountChooser handling for headless login, adapted into `extension/runtime/acp/headless-oauth.ts`.

Each contribution remains distinguishable in the owned source and its feature commit where applicable. The adapter does not copy fork-specific package names, publishing identities or personal skill files.

```
MIT License

Copyright (c) 2026 pi-gemini-acp-provider contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
