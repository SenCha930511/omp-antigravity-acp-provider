# Contributing

## Local development

Install these prerequisites.

- Node.js 22.19.0 or newer. CI uses Node.js 22.19.0 and npm 11.21.2.
- Bun 1.4.4.
- OMP 18.19.0 available as `omp` on `PATH`. The package is `@oh-my-pi/pi-coding-agent`.

Install exact dependencies and run the default verification suite.

```sh
npm ci
npm run check
```

`npm run check` does not start real ACP sessions or send model requests. Its final `test:packed` step builds the package and verifies it with an offline OMP catalog load. Pull request CI downloads tools and dependencies, then runs this same command. It does not run `npm run test:marketplace`, live inference, Google authentication, or credentialed sessions.

Keep live tests separate and explicit. They consume account quota and create Antigravity sessions. Never commit or upload credentials, OAuth callbacks, user configuration, session history, downloaded Google runtimes, or generated bundles.

## Pull requests

Open a real pull request against `main`. A real pull request is required to validate the GitHub workflow, required check, and review rules. Local CI emulators do not prove those settings.

Use a conventional PR title with a lowercase prefix, a colon, and an imperative summary. For example, use `fix: preserve ACP cancellation`.

Preserve the official Antigravity ACP protocol and existing upstream behavior. Keep upstream code unchanged and put compatibility changes in this adapter. Do not commit generated bundles, downloaded runtimes, credentials, or session data.

PR CI has read-only repository access and no Google secrets. The job downloads tools and dependencies without contacting model services. Do not add live inference, credentialed sessions, or `test:marketplace` to PR validation. GitHub Actions updates are handled weekly by Dependabot.

## Branch protection

First obtain a green `CI` run on a real pull request. Then enable the exact `verify` job from that workflow as the required status check for `main`. Do not require a similarly named check from another workflow.

For a solo maintainer, do not enable `prevent-self-review` on the protected release environment. It would block the only maintainer from approving a release.

If a broken required workflow prevents the recovery pull request from merging, a repository administrator may edit or temporarily disable the ruleset. Restore the ruleset and the exact `verify` requirement after the fix lands.

## Release runbook

PR validation and releases are separate. Never create a tag or publish a package to test CI. The release workflow belongs in `.github/workflows/release.yml` and is not part of PR CI.

### Prepare a version

1. Choose a new version and a new `v*` tag. Never reuse, move, or retarget a tag after a bad or partial publish. Ship corrections under a new version and tag.
2. Set the same unprefixed version in all release metadata.
   - Root `package.json`.
   - Both root version fields in `package-lock.json`.
   - `marketplace/antigravity-acp/package.json`.
   - `ADAPTER_VERSION` in `marketplace/antigravity-acp/provision.ts`.
   - The plugin entry in `.omp-plugin/marketplace.json`.
3. Add the release notes to `CHANGELOG.md`. The first visible `##` version heading after `# Changelog` must be `## X.Y.Z — YYYY-MM-DD` with the actual version and a valid calendar date. Fenced code and HTML comments are not release headings.
4. Run `npm run check` and `npm run check:versions`, then review the package contents. Confirm that no generated runtime, credentials, or session data will be released. The version check compares all six declarations without reading the changelog.
5. Before an intended tag, run `node scripts/check-release-versions.mjs --release --tag vX.Y.Z`. Release mode additionally requires the exact tag and a matching first visible `## X.Y.Z — YYYY-MM-DD` changelog heading; fenced examples, HTML comments, later historical entries, and duplicate target-version headings do not satisfy that boundary.
6. Merge the release preparation through the normal protected pull request flow. Tag the resulting release commit only when publishing is intended.

### Protected tag workflow

Configure the protected `v*` tag workflow with separate `release-verify`, `publish`, and `github-release` jobs. Keep the release verification name distinct from the pull request `verify` check. The publish job depends on successful verification. The GitHub release job depends on successful publication.

Restrict `npm-publish` deployments to `v*` tags. Set the release commit as `gitHead` before packing. Verify and publish the exact same package artifact so later steps cannot silently pack different contents. A tarball publish does not run `prepublishOnly`; the release verification job's full check is the publishing gate.

Configure npm trusted publishing for the exact `.github/workflows/release.yml` workflow and the `npm-publish` GitHub environment. Use direct `npm publish` with GitHub OIDC and npm provenance. Do not substitute a long-lived npm token or an indirect publishing action.

Make workflow re-runs safe. Detect an already published exact npm package version and verify it instead of publishing a duplicate. Detect an existing GitHub release for the tag and verify or reuse it instead of creating a duplicate.

OIDC authentication, npm provenance, registry publication, and GitHub release creation can be proven only by a real protected-tag release. A green pull request does not verify any of them. Record their actual results during the release and never claim release validation from PR CI alone.
