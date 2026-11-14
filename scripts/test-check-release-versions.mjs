import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "check-release-versions.mjs");
const name = "omp-antigravity-acp-provider";
const version = "1.2.3";
const adapterPath = "marketplace/antigravity-acp/provision.ts";
const changelog = `# Changelog\n\n## ${version} — 2026-11-12\n\n- Fixture release.\n`;

function writeText(root, relative, text) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function writeJson(root, relative, value) {
  writeText(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

function updateJson(root, relative, update) {
  const file = path.join(root, relative);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  update(value);
  writeJson(root, relative, value);
}

function writeFixture(root) {
  writeJson(root, "package.json", { name, version });
  writeJson(root, "package-lock.json", { name, version, lockfileVersion: 3, packages: { "": { name, version } } });
  writeJson(root, "marketplace/antigravity-acp/package.json", { name, version, private: true });
  writeText(root, adapterPath, `export const ADAPTER_NAME = "${name}";\nexport const ADAPTER_VERSION = "${version}";\n`);
  writeJson(root, ".omp-plugin/marketplace.json", { name: "fixture", plugins: [{ name, version }] });
}

function fixture(t, changelogText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-version-check-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeFixture(root);
  if (changelogText !== undefined) writeText(root, "CHANGELOG.md", changelogText);
  return root;
}

function invoke(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.equal(result.error, undefined);
  return result;
}

function check(root, ...args) {
  return invoke(["--root", root, ...args]);
}

function outcome(result, status) {
  assert.equal(result.status, status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function snapshot(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else files.push([path.relative(root, file), fs.readFileSync(file).toString("base64")]);
    }
  }
  visit(root);
  return files;
}

test("all six sources and CRLF release metadata pass, repeatedly without writes", (t) => {
  const root = fixture(t, changelog.replaceAll("\n", "\r\n"));
  const before = snapshot(root);
  outcome(check(root), 0);
  const args = ["--root", root, "--release", "--tag", `v${version}`];
  const first = invoke(args);
  outcome(first, 0);
  const second = invoke(args);
  outcome(second, 0);
  assert.deepEqual({ status: second.status, stdout: second.stdout, stderr: second.stderr }, {
    status: first.status, stdout: first.stdout, stderr: first.stderr,
  });
  assert.deepEqual(snapshot(root), before);
});

test("a mismatch in every machine source identifies that source", (t) => {
  const root = fixture(t);
  const cases = [
    ["package.json version", (value) => updateJson(root, "package.json", (json) => { json.version = value; })],
    ["package-lock.json root version", (value) => updateJson(root, "package-lock.json", (json) => { json.version = value; })],
    ["package-lock.json packages[''] version", (value) => updateJson(root, "package-lock.json", (json) => { json.packages[""].version = value; })],
    ["marketplace/antigravity-acp/package.json version", (value) => updateJson(root, "marketplace/antigravity-acp/package.json", (json) => { json.version = value; })],
    ["provision.ts ADAPTER_VERSION", (value) => writeText(root, adapterPath, `export const ADAPTER_VERSION = "${value}";\n`)],
    ["marketplace.json plugin version", (value) => updateJson(root, ".omp-plugin/marketplace.json", (json) => { json.plugins[0].version = value; })],
  ];
  for (const [source, mutate] of cases) {
    writeFixture(root);
    mutate("9.8.7");
    assert.match(outcome(check(root), 1).stderr, new RegExp(source.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("invalid authoritative versions are rejected without inference", (t) => {
  const root = fixture(t);
  for (const invalid of ["", 10203, null, "1.2", "v1.2.3", "01.2.3", "1.2.3-alpha", "1.2.3+build"]) {
    updateJson(root, "package.json", (json) => { json.version = invalid; });
    assert.match(outcome(check(root, "--release", "--tag", "v9.9.9"), 1).stderr, /package\.json version/);
  }
});

test("malformed JSON, missing fields and an authoritative name mismatch fail", (t) => {
  const root = fixture(t);
  writeText(root, "package-lock.json", "{ invalid\n");
  assert.match(outcome(check(root), 1).stderr, /package-lock\.json: is not valid JSON/);
  writeFixture(root);
  updateJson(root, "marketplace/antigravity-acp/package.json", (json) => { delete json.version; });
  assert.match(outcome(check(root), 1).stderr, /marketplace\/antigravity-acp\/package\.json version/);
  writeFixture(root);
  updateJson(root, "package-lock.json", (json) => { delete json.version; });
  assert.match(outcome(check(root), 1).stderr, /package-lock\.json root version/);
  writeFixture(root);
  updateJson(root, "package.json", (json) => { json.name = "not-the-provider"; });
  assert.match(outcome(check(root), 1).stderr, /package\.json name/);
  writeFixture(root);
  updateJson(root, "marketplace/antigravity-acp/package.json", (json) => { json.name = "not-the-provider"; });
  assert.match(outcome(check(root), 1).stderr, /marketplace\/antigravity-acp\/package\.json name/);
});

test("plugin selection rejects no match and duplicate matching names", (t) => {
  const root = fixture(t);
  updateJson(root, ".omp-plugin/marketplace.json", (json) => { json.plugins[0].name = "other"; });
  assert.match(outcome(check(root), 1).stderr, /expected exactly one plugin/);
  writeFixture(root);
  updateJson(root, ".omp-plugin/marketplace.json", (json) => { json.plugins.push({ ...json.plugins[0] }); });
  assert.match(outcome(check(root), 1).stderr, /expected exactly one plugin/);
});

test("adapter declaration must be present, literal and unique", (t) => {
  const root = fixture(t);
  writeText(root, adapterPath, "export const OTHER_VERSION = '1.2.3';\n");
  assert.match(outcome(check(root), 1).stderr, /ADAPTER_VERSION/);
  writeText(root, adapterPath, `export const ADAPTER_VERSION = "${version}";\nexport const ADAPTER_VERSION = "${version}";\n`);
  assert.match(outcome(check(root), 1).stderr, /ADAPTER_VERSION/);
  writeText(root, adapterPath, "export const ADAPTER_VERSION = '1.2.3';\n");
  assert.match(outcome(check(root), 1).stderr, /ADAPTER_VERSION/);
});

test("release reads the changelog and checks only the first heading plus duplicates", (t) => {
  const withoutChangelog = fixture(t);
  outcome(check(withoutChangelog), 0);
  assert.match(outcome(check(withoutChangelog, "--release", "--tag", `v${version}`), 1).stderr, /CHANGELOG\.md/);
  const draft = fixture(t, "# Changelog\n\n## Unreleased\n");
  outcome(check(draft), 0);
  assert.match(outcome(check(draft, "--release", "--tag", `v${version}`), 1).stderr, /first ## heading/);
  const root = fixture(t, `# Changelog\n\n## 9.9.9 — 2026-11-12\n\n- Wrong version.\n\n## ${version} — 2026-11-12\n\n- Target version.\n`);
  outcome(check(root), 0);
  assert.match(outcome(check(root, "--release", "--tag", `v${version}`), 1).stderr, /first ## heading/);
  writeText(root, "CHANGELOG.md", `${changelog}\n## ${version} — 2026-11-11\n\n- Duplicate.\n`);
  assert.match(outcome(check(root, "--release", "--tag", `v${version}`), 1).stderr, /duplicate heading/);
  writeText(root, "CHANGELOG.md", `# Changelog\n\n## ${version} — 2026-11-12\n\n   \n\n## 1.2.2 — 2026-11-10\n\n- Older.\n`);
  assert.match(outcome(check(root, "--release", "--tag", `v${version}`), 1).stderr, /release section for 1\.2\.3 must not be empty/);
  writeText(root, "CHANGELOG.md", "Not a changelog\n");
  assert.match(outcome(check(root, "--release", "--tag", `v${version}`), 1).stderr, /must start with # Changelog/);
});

test("wrong, unprefixed and prerelease tags fail release content checks", (t) => {
  const root = fixture(t, changelog);
  for (const tag of ["v9.9.9", version, `v${version}-alpha`]) {
    assert.match(outcome(check(root, "--release", "--tag", tag), 1).stderr, /release tag/);
  }
});

test("argument boundaries are usage errors", (t) => {
  const root = fixture(t);
  const cases = [
    ["--root", root, "--release"],
    ["--root", root, "--tag", `v${version}`],
    ["--root", root, "--notes-output", path.join(root, "notes.md")],
    ["--root", root, "--release", "--tag"],
    ["--root", root, "--release", "--tag", ""],
    ["--root", root, "--release", "--tag", `v${version}`, "--notes-output"],
    ["--root", root, "--release", "--tag", `v${version}`, "--notes-output", "--root"],
    ["--root", root, "--release", "--tag", `v${version}`, "--notes-output", path.join(root, "a.md"), "--notes-output", path.join(root, "b.md")],
    ["--root", root, "--release", "--release", "--tag", `v${version}`],
    ["--root", root, "--tag", `v${version}`, "--tag", `v${version}`, "--release"],
    ["--root", root, "--root", root],
    ["--root"],
    ["--root", root, "--unknown"],
  ];
  for (const args of cases) assert.match(outcome(invoke(args), 2).stderr, /Usage:/);
});

test("hidden changelog headings cannot replace the visible release heading", (t) => {
  const hidden = [
    `# Changelog\n\n<!--\n## ${version} — 2026-11-12\n-->\n\n## 9.9.9 — 2026-11-13\n`,
    `# Changelog\n\n\`\`\`markdown\n## ${version} — 2026-11-12\n\`\`\`\n\n## 9.9.9 — 2026-11-13\n`,
  ];
  for (const hiddenText of hidden) {
    const root = fixture(t, hiddenText);
    outcome(check(root), 0);
    assert.match(outcome(check(root, "--release", "--tag", `v${version}`), 1).stderr, /first ## heading/);
  }
  const root = fixture(t, `${changelog}\n\`\`\`markdown\n## ${version} — 2026-11-11\n\`\`\`\n<!--\n## ${version} — 2026-11-11\n-->\n`);
  outcome(check(root, "--release", "--tag", `v${version}`), 0);
});

test("comments and template strings are not adapter declarations", (t) => {
  const root = fixture(t);
  const hidden = [
    `/*\nexport const ADAPTER_VERSION = "${version}";\n*/\n`,
    `const fixture = \`\nexport const ADAPTER_VERSION = "${version}";\n\`;\n`,
  ];
  for (const source of hidden) {
    writeText(root, adapterPath, source);
    assert.match(outcome(check(root), 1).stderr, /ADAPTER_VERSION/);
  }
});

test("invalid calendar dates and trailing newlines are not valid release versions", (t) => {
  const badDate = fixture(t, changelog.replace("2026-11-12", "2026-99-99"));
  assert.match(outcome(check(badDate, "--release", "--tag", `v${version}`), 1).stderr, /YYYY-MM-DD/);
  const trailingNewline = fixture(t, changelog);
  updateJson(trailingNewline, "package.json", (json) => { json.version = `${version}\n`; });
  assert.match(outcome(check(trailingNewline, "--release", "--tag", `v${version}`), 1).stderr, /package\.json version/);
});

test("notes-output writes trimmed release notes with fenced blocks only when all checks pass", (t) => {
  const sectionBody = [
    "- First change.",
    "",
    "```markdown",
    "## 0.0.0 — 2026-01-01",
    "code fence content",
    "```",
    "",
    "### Details",
    "",
    "- Second change.",
  ].join("\n");
  const fullChangelog = `# Changelog\n\n## ${version} — 2026-11-12\n\n\n${sectionBody}\n\n\n## 1.2.2 — 2026-11-10\n\n- Older release.\n`;
  const root = fixture(t, fullChangelog);
  const notesFile = path.join(root, "out", "release-notes.md");

  outcome(check(root, "--release", "--tag", `v${version}`, "--notes-output", notesFile), 0);
  assert.equal(fs.readFileSync(notesFile, "utf8"), `${sectionBody}\n`);

  const failedNotesFile = path.join(root, "out", "failed-notes.md");
  outcome(check(root, "--release", "--tag", "v9.9.9", "--notes-output", failedNotesFile), 1);
  assert.equal(fs.existsSync(failedNotesFile), false);

  updateJson(root, ".omp-plugin/marketplace.json", (json) => { json.plugins[0].version = "9.9.9"; });
  const mismatchNotesFile = path.join(root, "out", "mismatch-notes.md");
  outcome(check(root, "--release", "--tag", `v${version}`, "--notes-output", mismatchNotesFile), 1);
  assert.equal(fs.existsSync(mismatchNotesFile), false);
});
