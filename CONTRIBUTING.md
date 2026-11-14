# Contributing

## Local development

Install these prerequisites.

- Node.js 22.19.0 or newer. CI uses Node.js 22.19.0 and npm 11.21.2.
- Bun 1.4.4.
- OMP 18.20.0 available as `omp` on `PATH`. The package is `@oh-my-pi/pi-coding-agent`.
The pinned Node and Bun versions live in `.github/actions/setup-toolchain/action.yml`. The npm pin lives in `.github/actions/setup-npm/action.yml`. The OMP pin and its lockfile live in `.github/omp-tools/`.

Install exact dependencies and run the default verification suite.

```sh
npm ci
npm run check
```

`npm run check` does not start real ACP sessions or send model requests. It typechecks the full adapter and marketplace TypeScript tree, verifies the six synchronized version declarations and release helper tests, builds the bundle once, runs the offline unit and wire suites, and finishes by verifying the packed tarball with an offline OMP catalog load. The `verify` job validates the PR title for fast feedback on pull request open and synchronize. The trusted `PR title` workflow runs on `pull_request_target` and revalidates the title on open, synchronize, reopen, and edit. Pull request CI runs this full check on Ubuntu under a clean isolated `HOME`, runs the full check on macOS, and runs the full `node scripts/test.mjs` unit suite plus the packed-tarball check on Windows. The Windows job skips the POSIX-only session-cleanup tests. The Bun and wire suites run on Ubuntu and macOS. It does not run `npm run test:marketplace`, live inference, Google authentication, or credentialed sessions.

Keep live tests separate and explicit. They consume account quota and create Antigravity sessions. Never commit or upload credentials, OAuth callbacks, user configuration, session history, downloaded Google runtimes, or generated bundles.

## Pull requests

Open a real pull request against `main`. A real pull request is required to validate the GitHub workflow, required check, and review rules. Local CI emulators do not prove those settings.

Use a conventional PR title with a lowercase prefix, a colon, and an imperative summary. For example, use `fix: preserve ACP cancellation`.

Preserve the official Antigravity ACP protocol and existing upstream behavior. Keep upstream code unchanged and put compatibility changes in this adapter. Do not commit generated bundles, downloaded runtimes, credentials, or session data.

PR CI has read-only repository access and no Google secrets. The job downloads tools and dependencies without contacting model services. Do not add live inference, credentialed sessions, or `test:marketplace` to PR validation. GitHub Actions and npm dependency updates are handled weekly by Dependabot.

## Branch protection

The `main` ruleset currently requires only `verify`. After the workflow lands and both portability legs are green, add `portability (macos-15)`, `portability (windows-2025)`, and `pr-title`. Do not require a similarly named check from another workflow. Keep the strict up-to-date policy so a merge commit cannot bypass a portability failure. Existing pull requests must update from `main` before they can produce the new checks.

For a solo maintainer, do not enable `prevent-self-review` on the protected release environment. It would block the only maintainer from approving a release.

If a broken required workflow prevents the recovery pull request from merging, a repository administrator may edit or temporarily disable the ruleset. Restore the ruleset and the exact required checks after the fix lands.

## Release runbook

PR validation and releases are separate. Never create a tag or publish a package to test CI. The release workflow belongs in `.github/workflows/release.yml` and is not part of PR CI.

### Prepare a version

1. Choose a new version and a new `v*` tag. Never reuse, move, or retarget a tag after a bad or partial publish. Ship corrections under a new version and tag.
2. Run `npm run release:bump X.Y.Z` to set the same unprefixed stable version in all six release declarations:
   - Root `package.json`.
   - Both root version fields in `package-lock.json`.
   - `marketplace/antigravity-acp/package.json`.
   - `ADAPTER_VERSION` in `marketplace/antigravity-acp/provision.ts`.
   - The plugin entry in `.omp-plugin/marketplace.json`.

   The helper runs `scripts/check-release-versions.mjs` first and refuses a malformed, inconsistent, or partially bumped tree before writing. It edits only the version values, so surrounding formatting and line endings survive, writes through same-directory temporary files, and restores every file changed by the invocation if any write or the post-write check fails. It rejects malformed or already-current target versions and does not edit `CHANGELOG.md`.
3. Add the release notes to `CHANGELOG.md`. The first visible `##` version heading after `# Changelog` must be `## X.Y.Z — YYYY-MM-DD` with the actual version and a valid calendar date. Fenced code and HTML comments are not release headings.
4. Run `npm run check`, then review the package contents. Confirm that no generated runtime, credentials, or session data will be released. `npm run check` already includes `npm run check:versions` plus the release-version and release-bump unit tests.
5. Before an intended tag, run `node scripts/check-release-versions.mjs --release --tag vX.Y.Z`. Release mode additionally requires the exact tag and a matching first visible, non-empty `## X.Y.Z — YYYY-MM-DD` changelog section; fenced examples, HTML comments, later historical entries, and duplicate target-version headings do not satisfy that boundary. `--notes-output <file>` extracts that exact release section for GitHub release notes.
6. Merge the release preparation through the normal protected pull request flow. Tag the resulting `main` commit only when publishing is intended. Tag only a commit that passed all required checks; the release workflow does not re-run the macOS and Windows portability jobs.

### Protected tag workflow

The tag workflow in `.github/workflows/release.yml` runs only for pushed `v*` tags; it has no pull-request or manual trigger. It keeps three jobs. `release-verify` checks the exact tag, verifies that the tagged commit is an ancestor of `origin/main`, validates the release metadata and changelog section, runs the full offline `npm run check`, sets `gitHead`, packs one tarball, and runs `node scripts/test-packed.mjs --tarball` against that exact tarball. `publish` downloads that exact artifact, verifies its name, version, `gitHead`, and `origin/main` ancestry, and runs under the protected `npm-publish` environment with `id-token: write`. `github-release` installs Bun and the project dependencies, depends on publication, verifies the downloaded tarball and published npm registry integrity, creates or updates the GitHub release, and then runs `npm run test:marketplace` against the published package.

Restrict `npm-publish` deployments to `v*` tags. The environment is created on first use without protection rules, so configure the tag restriction before pushing the first release tag. The verification job sets the release commit as `gitHead` before packing and verifies that the checked-out `HEAD` is the tag commit on `origin/main`. The publish and release jobs consume the uploaded tarball instead of repacking, so later steps cannot silently publish different contents. A tarball publish does not run `prepublishOnly`; the release verification job's full check and exact-tarball `test-packed.mjs` run are the publishing gate.

Configure npm trusted publishing for the exact `.github/workflows/release.yml` workflow and the `npm-publish` GitHub environment. Use direct `npm publish --provenance` with GitHub OIDC. Do not add a long-lived `NPM_TOKEN` secret or an indirect publishing action.

Make workflow re-runs safe. When the exact npm version already exists, compare the local tarball integrity with the registry `dist.integrity`; fail on a mismatch and skip only when the bytes match. A local rebuild of the same commit produced an identical SHA-512, and `npm pack` normalizes file mtimes. The packed artifact is retained for 30 days. Re-run all jobs when the artifact has expired; re-run only failed jobs while it is available. For GitHub releases, upload the exact tarball to an existing tag release and update its title, changelog notes, and non-draft state with `--draft=false` and `--prerelease=false`, or create the release with `--verify-tag` and `--notes-file`.

Publish one release tag at a time. The publish job serializes every tag under one concurrency group, so a second publish waits for the first. Verify jobs for different tags can run in parallel. Do not push a new tag while a publish is waiting for approval. If the version being published is older than the current npm `latest`, it publishes under the `backfill` dist-tag and creates the GitHub release with `--latest=false` so `latest` does not move backwards. Push tags only to `SenCha930511/omp-antigravity-acp-provider`; the npm trusted publisher is bound to that repository, so a tag pushed to a fork cannot publish.

OIDC authentication, npm provenance, registry publication, and GitHub release creation can be proven only by a real protected-tag release. A green pull request does not verify any of them. Record their actual results during the release and never claim release validation from PR CI alone.
