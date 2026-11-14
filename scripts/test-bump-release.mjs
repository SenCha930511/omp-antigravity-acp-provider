import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyEdits, planEdits, run } from "./bump-release.mjs";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "bump-release.mjs");
const checker = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "check-release-versions.mjs");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const name = "omp-antigravity-acp-provider";
const current = "1.2.3";
const target = "2.3.4";
const adapterPath = "marketplace/antigravity-acp/provision.ts";
const fixtureFiles = [
  "package.json",
  "package-lock.json",
  "marketplace/antigravity-acp/package.json",
  adapterPath,
  ".omp-plugin/marketplace.json",
];
const projectFiles = [
  "package.json",
  "package-lock.json",
  "marketplace/antigravity-acp/package.json",
  adapterPath,
  ".omp-plugin/marketplace.json",
];
const projectBefore = new Map(projectFiles.map((relative) => [
  relative,
  fs.readFileSync(path.join(projectRoot, relative)).toString("base64"),
]));

function fixtureText(relative, version) {
  switch (relative) {
    case "package.json":
      return `{\n  "name": "${name}",\n  "version": "${version}",\n  "nested": {\n    "version": "0.0.9"\n  },\n  "dependencies": {\n    "alpha": "1.0.0"\n  }\n}\n`;
    case "package-lock.json":
      return `{\r\n  "name": "${name}",\r\n  "version": "${version}",\r\n  "lockfileVersion": 3,\r\n  "packages": {\r\n    "": {\r\n      "name": "${name}",\r\n      "version": "${version}"\r\n    },\r\n    "node_modules/alpha": {\r\n      "version": "1.0.0"\r\n    }\r\n  }\r\n}\r\n`;
    case "marketplace/antigravity-acp/package.json":
      return `{\n  "name": "${name}",\n  "version": "${version}",\n  "private": true\n}\n`;
    case adapterPath:
      return `/*\nexport const ADAPTER_VERSION = "0.0.1";\n*/\nconst fixture = \`\nexport const ADAPTER_VERSION = "0.0.2";\n\`;\nexport const ADAPTER_NAME = "${name}";\nexport const ADAPTER_VERSION = "${version}";\n`;
    case ".omp-plugin/marketplace.json":
      return `{\n  "name": "fixture",\n  "plugins": [\n    {\n      "name": "other-plugin",\n      "version": "9.9.9"\n    },\n    {\n      "name": "${name}",\n      "version": "${version}"\n    }\n  ]\n}\n`;
    default:
      throw new Error(`unknown fixture: ${relative}`);
  }
}

function writeText(root, relative, text) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function readText(root, relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function writeFixture(root) {
  for (const relative of fixtureFiles) writeText(root, relative, fixtureText(relative, current));
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "release-bump-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "fixture root");
  fs.mkdirSync(root);
  writeFixture(root);
  return root;
}

function replaceOccurrence(text, from, to, occurrence) {
  let index = -1;
  let start = 0;
  for (let count = 0; count < occurrence; count += 1) {
    index = text.indexOf(from, start);
    if (index === -1) throw new Error(`missing occurrence ${occurrence} of ${JSON.stringify(from)}`);
    start = index + from.length;
  }
  return text.slice(0, index) + to + text.slice(index + from.length);
}

function mutateSource(root, source, value) {
  const relative = {
    "package.json version": "package.json",
    "package-lock.json root version": "package-lock.json",
    "package-lock.json packages[''] version": "package-lock.json",
    "marketplace/antigravity-acp/package.json version": "marketplace/antigravity-acp/package.json",
    "marketplace/antigravity-acp/provision.ts ADAPTER_VERSION": adapterPath,
    ".omp-plugin/marketplace.json plugin version": ".omp-plugin/marketplace.json",
  }[source];
  assert.ok(relative, source);
  const text = readText(root, relative);
  let updated;
  if (source === "package-lock.json root version") {
    updated = replaceOccurrence(text, `"version": "${current}"`, `"version": "${value}"`, 1);
  } else if (source === "package-lock.json packages[''] version") {
    updated = replaceOccurrence(text, `"version": "${current}"`, `"version": "${value}"`, 2);
  } else if (source === "marketplace/antigravity-acp/provision.ts ADAPTER_VERSION") {
    updated = text.replace(`ADAPTER_VERSION = "${current}"`, `ADAPTER_VERSION = "${value}"`);
  } else {
    updated = text.replace(`"version": "${current}"`, `"version": "${value}"`);
  }
  assert.notEqual(updated, text, source);
  writeText(root, relative, updated);
}

function invoke(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function bump(root, version) {
  return invoke([version, "--root", root]);
}

function check(root) {
  const result = spawnSync(process.execPath, [checker, "--root", root], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function outcome(result, status) {
  assert.equal(result.status, status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function snapshot(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else files.push([path.relative(root, file), fs.readFileSync(file).toString("base64")]);
    }
  }
  visit(root);
  return files;
}

function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("bumps six declarations in a path with spaces and preserves every other byte", (t) => {
  const root = fixture(t);
  assert.match(root, / /);
  const before = snapshot(root);
  const result = outcome(bump(root, target), 0);
  assert.match(result.stdout, /Bumped 1\.2\.3 -> 2\.3\.4 across 6 version declarations in 5 files/);
  for (const relative of fixtureFiles) {
    assert.equal(readText(root, relative), fixtureText(relative, target), relative);
  }
  assert.ok(readText(root, "package-lock.json").includes(`"version": "${target}"\r\n`));
  assert.notDeepEqual(snapshot(root), before);
  outcome(check(root), 0);
});

test("repeated runs are deterministic and reject the version they already applied", (t) => {
  const root = fixture(t);
  outcome(bump(root, target), 0);
  const first = snapshot(root);
  const repeated = outcome(bump(root, target), 1);
  assert.match(repeated.stderr, /already the current version/);
  assert.deepEqual(snapshot(root), first);
  outcome(bump(root, "2.3.5"), 0);
  outcome(check(root), 0);
  assert.match(readText(root, "package.json"), /"version": "2\.3\.5"/);
  assert.match(outcome(bump(root, "2.3.5"), 1).stderr, /already the current version/);
});

test("an equal target version is rejected before writes", (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  const result = outcome(bump(root, current), 1);
  assert.match(result.stderr, /already the current version/);
  assert.deepEqual(snapshot(root), before);
});

test("a tree with any one drifted source is rejected before writes", (t) => {
  const sources = [
    "package.json version",
    "package-lock.json root version",
    "package-lock.json packages[''] version",
    "marketplace/antigravity-acp/package.json version",
    "marketplace/antigravity-acp/provision.ts ADAPTER_VERSION",
    ".omp-plugin/marketplace.json plugin version",
  ];
  for (const source of sources) {
    for (const value of ["9.8.7", target]) {
      const root = fixture(t);
      mutateSource(root, source, value);
      const before = snapshot(root);
      const result = outcome(bump(root, target), 1);
      assert.match(result.stderr, /Release precheck failed/, `${source} at ${value}`);
      assert.match(result.stderr, new RegExp(escapeRegExp(source)), `${source} at ${value}`);
      assert.deepEqual(snapshot(root), before, `${source} at ${value}`);
    }
  }
});

test("a partially pre-bumped tree is rejected before writes", (t) => {
  const root = fixture(t);
  mutateSource(root, "package-lock.json root version", target);
  const before = snapshot(root);
  const result = outcome(bump(root, target), 1);
  assert.match(result.stderr, /Release precheck failed/);
  assert.deepEqual(snapshot(root), before);
});

test("malformed JSON, missing fields, duplicate declarations and duplicate plugins fail before writes", (t) => {
  const malformed = fixture(t);
  writeText(malformed, "package-lock.json", "{ invalid\n");
  let before = snapshot(malformed);
  let result = outcome(bump(malformed, target), 1);
  assert.match(result.stderr, /is not valid JSON/);
  assert.deepEqual(snapshot(malformed), before);

  const missing = fixture(t);
  const lock = JSON.parse(readText(missing, "package-lock.json"));
  delete lock.packages[""].version;
  writeText(missing, "package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
  before = snapshot(missing);
  result = outcome(bump(missing, target), 1);
  assert.match(result.stderr, /packages\[''\] version/);
  assert.deepEqual(snapshot(missing), before);

  const duplicateAdapter = fixture(t);
  writeText(duplicateAdapter, adapterPath, `${readText(duplicateAdapter, adapterPath)}export const ADAPTER_VERSION = "${current}";\n`);
  before = snapshot(duplicateAdapter);
  result = outcome(bump(duplicateAdapter, target), 1);
  assert.match(result.stderr, /ADAPTER_VERSION/);
  assert.deepEqual(snapshot(duplicateAdapter), before);

  const duplicatePlugin = fixture(t);
  const marketplace = JSON.parse(readText(duplicatePlugin, ".omp-plugin/marketplace.json"));
  marketplace.plugins.push({ ...marketplace.plugins[1] });
  writeText(duplicatePlugin, ".omp-plugin/marketplace.json", `${JSON.stringify(marketplace, null, 2)}\n`);
  before = snapshot(duplicatePlugin);
  result = outcome(bump(duplicatePlugin, target), 1);
  assert.match(result.stderr, /expected exactly one plugin/);
  assert.deepEqual(snapshot(duplicatePlugin), before);
});

test("invalid targets and argument boundaries are usage errors without writes", (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  const cases = [
    [],
    ["--root", root],
    [current, "--root"],
    [current, "--root", ""],
    [current, "--root", root, "--root", root],
    [current, "--root", root, "extra"],
    [current, "--unknown"],
    ["", "--root", root],
    ["1.2", "--root", root],
    ["v1.2.3", "--root", root],
    ["01.2.3", "--root", root],
    ["1.2.3-alpha", "--root", root],
    ["1.2.3+build", "--root", root],
    ["1.2.3 ", "--root", root],
    ["1.2.3\n", "--root", root],
  ];
  for (const args of cases) {
    const result = outcome(invoke(args), 2);
    assert.match(result.stderr, /Usage:/, JSON.stringify(args));
  }
  assert.deepEqual(snapshot(root), before);
});

test("a write failure restores every file changed by that invocation", (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  const plan = planEdits(root, target);
  assert.equal(plan.declarations, 6);
  let failed = false;
  assert.throws(() => applyEdits(root, plan.edits, {
    writeFile(file, bytes, options) {
      if (!failed && path.basename(file).startsWith("provision.ts.bump-")) {
        failed = true;
        throw new Error("simulated disk failure");
      }
      fs.writeFileSync(file, bytes, options);
    },
  }), /simulated disk failure; all changed files were restored/);
  assert.equal(failed, true);
  assert.deepEqual(snapshot(root), before);
});

test("post-write verification failure restores every file", (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  let calls = 0;
  const status = run([target, "--root", root], {
    spawn(command, args) {
      calls += 1;
      assert.equal(command, process.execPath);
      assert.equal(args[0], checker);
      assert.deepEqual(args.slice(1), ["--root", root]);
      return calls === 1
        ? { status: 0, stdout: "", stderr: "" }
        : { status: 1, stdout: "", stderr: "simulated postcheck failure\n" };
    },
  });
  assert.equal(status, 1);
  assert.equal(calls, 2);
  assert.deepEqual(snapshot(root), before);
});

test("fixture runs never mutate the project release metadata", () => {
  for (const relative of projectFiles) {
    assert.equal(
      fs.readFileSync(path.join(projectRoot, relative)).toString("base64"),
      projectBefore.get(relative),
      relative,
    );
  }
});
