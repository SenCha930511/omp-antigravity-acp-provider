import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "omp-antigravity-acp-provider";
const STABLE_VERSION = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
const VERSION_PATTERN = new RegExp(`^${STABLE_VERSION}(?![\\s\\S])`);
const ADAPTER_DECLARATION = /^[ \t]*export const ADAPTER_VERSION = "([^"\r\n]*)";[ \t]*$/gm;
const USAGE = "Usage: node scripts/bump-release.mjs <X.Y.Z> [--root <dir>]";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CHECKER_PATH = fileURLToPath(new URL("./check-release-versions.mjs", import.meta.url));
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

const JSON_VERSION_SOURCES = [
  ["package.json", [["version"]]],
  ["package-lock.json", [["version"], ["packages", "", "version"]]],
  ["marketplace/antigravity-acp/package.json", [["version"]]],
];
const ADAPTER_SOURCE = "marketplace/antigravity-acp/provision.ts";
const MARKETPLACE_SOURCE = ".omp-plugin/marketplace.json";

export function parseArgs(argv, defaultRoot = PROJECT_ROOT) {
  const options = { root: defaultRoot, version: undefined };
  let rootSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      if (rootSeen) throw new Error("--root may be supplied only once");
      rootSeen = true;
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--root requires a nonempty value");
      options.root = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`unknown argument: ${argument}`);
    if (options.version !== undefined) throw new Error(`unexpected argument: ${argument}`);
    options.version = argument;
  }
  if (options.version === undefined) throw new Error("a target X.Y.Z version is required");
  if (!VERSION_PATTERN.test(options.version)) throw new Error(`invalid target version: ${options.version}`);
  return options;
}

function readText(root, relative) {
  const file = path.join(root, relative);
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    throw new Error(`${relative}: could not be read (${error.code ?? error.message})`);
  }
  let mode;
  try {
    mode = fs.statSync(file).mode;
  } catch (error) {
    throw new Error(`${relative}: could not be inspected (${error.code ?? error.message})`);
  }
  return { bytes, mode, text: bytes.toString("utf8") };
}

function parseJson(text, relative) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${relative}: is not valid JSON`);
  }
}

// Records the exact character span of selected JSON member values without
// reserializing the document, so formatting and line endings are preserved.
function findMemberSpans(text, keep) {
  const spans = new Map();
  const primitive = /(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/y;
  const skipWhitespace = (index) => {
    let cursor = index;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    return cursor;
  };
  const stringEnd = (index) => {
    let cursor = index + 1;
    while (cursor < text.length) {
      if (text[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (text[cursor] === '"') return cursor + 1;
      cursor += 1;
    }
    throw new Error("unterminated JSON string");
  };
  const parseValue = (index, keys) => {
    const cursor = skipWhitespace(index);
    const character = text[cursor];
    if (character === "{") return parseObject(cursor, keys);
    if (character === "[") return parseArray(cursor, keys);
    if (character === '"') return stringEnd(cursor);
    primitive.lastIndex = cursor;
    const match = primitive.exec(text);
    if (!match) throw new Error("unexpected JSON token");
    return cursor + match[0].length;
  };
  const parseObject = (index, keys) => {
    let cursor = skipWhitespace(index + 1);
    if (text[cursor] === "}") return cursor + 1;
    while (true) {
      cursor = skipWhitespace(cursor);
      if (text[cursor] !== '"') throw new Error("expected a JSON object key");
      const keyEnd = stringEnd(cursor);
      const key = JSON.parse(text.slice(cursor, keyEnd));
      cursor = skipWhitespace(keyEnd);
      if (text[cursor] !== ":") throw new Error("expected a JSON colon");
      const valueStart = skipWhitespace(cursor + 1);
      const valueEnd = parseValue(valueStart, [...keys, key]);
      const memberKeys = [...keys, key];
      if (keep(memberKeys)) spans.set(JSON.stringify(memberKeys), { start: valueStart, end: valueEnd });
      cursor = skipWhitespace(valueEnd);
      if (text[cursor] === ",") {
        cursor += 1;
        continue;
      }
      if (text[cursor] === "}") return cursor + 1;
      throw new Error("expected a JSON comma or closing brace");
    }
  };
  const parseArray = (index, keys) => {
    let cursor = skipWhitespace(index + 1);
    if (text[cursor] === "]") return cursor + 1;
    let element = 0;
    while (true) {
      cursor = skipWhitespace(cursor);
      const valueEnd = parseValue(cursor, [...keys, element]);
      cursor = skipWhitespace(valueEnd);
      if (text[cursor] === ",") {
        element += 1;
        cursor += 1;
        continue;
      }
      if (text[cursor] === "]") return cursor + 1;
      throw new Error("expected a JSON comma or closing bracket");
    }
  };
  parseValue(0, []);
  return spans;
}

function replaceSpans(text, replacements, relative) {
  const ordered = [...replacements].sort((left, right) => right.start - left.start);
  let result = text;
  let boundary = text.length + 1;
  for (const replacement of ordered) {
    if (replacement.end > boundary) throw new Error(`${relative}: overlapping version declarations`);
    if (text.slice(replacement.start, replacement.end) !== replacement.expected) {
      throw new Error(`${relative}: version declaration does not contain the current version`);
    }
    result = result.slice(0, replacement.start) + replacement.replacement + result.slice(replacement.end);
    boundary = replacement.start;
  }
  return result;
}

function editRecord(relative, file, text, declarations) {
  return { relative, mode: file.mode, before: file.bytes, after: Buffer.from(text, "utf8"), declarations };
}

function jsonEdit(root, relative, wanted, current, target) {
  const file = readText(root, relative);
  parseJson(file.text, relative);
  const wantedKeys = new Set(wanted.map((keys) => JSON.stringify(keys)));
  const spans = findMemberSpans(file.text, (keys) => wantedKeys.has(JSON.stringify(keys)));
  const replacements = wanted.map((keys) => {
    const span = spans.get(JSON.stringify(keys));
    if (!span) throw new Error(`${relative}: missing ${keys.map(String).join(".")}`);
    return {
      start: span.start,
      end: span.end,
      expected: JSON.stringify(current),
      replacement: JSON.stringify(target),
    };
  });
  return editRecord(relative, file, replaceSpans(file.text, replacements, relative), replacements.length);
}

function marketplaceEdit(root, current, target) {
  const file = readText(root, MARKETPLACE_SOURCE);
  parseJson(file.text, MARKETPLACE_SOURCE);
  const spans = findMemberSpans(file.text, (keys) => keys[0] === "plugins");
  const indices = [];
  for (const [encoded, span] of spans) {
    const keys = JSON.parse(encoded);
    if (keys.length !== 3 || keys[0] !== "plugins" || typeof keys[1] !== "number" || keys[2] !== "name") continue;
    const value = JSON.parse(file.text.slice(span.start, span.end));
    if (value === PACKAGE_NAME) indices.push(keys[1]);
  }
  if (indices.length !== 1) {
    throw new Error(`${MARKETPLACE_SOURCE}: expected exactly one plugin named ${PACKAGE_NAME}, found ${indices.length}`);
  }
  const versionSpan = spans.get(JSON.stringify(["plugins", indices[0], "version"]));
  if (!versionSpan) throw new Error(`${MARKETPLACE_SOURCE}: plugin ${PACKAGE_NAME} has no version declaration`);
  const replacements = [{
    start: versionSpan.start,
    end: versionSpan.end,
    expected: JSON.stringify(current),
    replacement: JSON.stringify(target),
  }];
  return editRecord(MARKETPLACE_SOURCE, file, replaceSpans(file.text, replacements, MARKETPLACE_SOURCE), 1);
}

// Marks characters that survive the checker's comment and template stripping,
// so only a real ADAPTER_VERSION declaration is rewritten.
function codeMask(text) {
  const mask = new Uint8Array(text.length);
  let state = "code";
  let cursor = 0;
  while (cursor < text.length) {
    if (state === "code") {
      if (text.startsWith("//", cursor)) {
        state = "line";
        cursor += 2;
        continue;
      }
      if (text.startsWith("/*", cursor)) {
        state = "block";
        cursor += 2;
        continue;
      }
      if (text[cursor] === "`") {
        state = "template";
        cursor += 1;
        continue;
      }
      mask[cursor] = 1;
      cursor += 1;
      continue;
    }
    if (state === "line") {
      if (text[cursor] === "\n" || text[cursor] === "\r") {
        mask[cursor] = 1;
        state = "code";
      }
      cursor += 1;
      continue;
    }
    if (state === "block") {
      if (text.startsWith("*/", cursor)) {
        state = "code";
        cursor += 2;
        continue;
      }
      cursor += 1;
      continue;
    }
    if (text[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (text[cursor] === "`") {
      state = "code";
      cursor += 1;
      continue;
    }
    cursor += 1;
  }
  return mask;
}

function adapterEdit(root, current, target) {
  const file = readText(root, ADAPTER_SOURCE);
  const mask = codeMask(file.text);
  const matches = [...file.text.matchAll(ADAPTER_DECLARATION)].filter((match) => {
    for (let index = match.index; index < match.index + match[0].length; index += 1) {
      if (mask[index] !== 1) return false;
    }
    return true;
  });
  if (matches.length !== 1) {
    throw new Error(`${ADAPTER_SOURCE}: expected exactly one literal double-quoted ADAPTER_VERSION declaration`);
  }
  const match = matches[0];
  const literalStart = match.index + match[0].indexOf('"') + 1;
  const literalEnd = literalStart + match[1].length;
  if (match[1] !== current) {
    throw new Error(`${ADAPTER_SOURCE}: ADAPTER_VERSION does not contain the current version`);
  }
  const text = file.text.slice(0, literalStart) + target + file.text.slice(literalEnd);
  return editRecord(ADAPTER_SOURCE, file, text, 1);
}

export function planEdits(root, target) {
  if (!VERSION_PATTERN.test(target ?? "")) throw new Error(`invalid target version: ${target}`);
  const packageFile = readText(root, "package.json");
  const packageJson = parseJson(packageFile.text, "package.json");
  const current = packageJson?.version;
  if (typeof current !== "string" || !VERSION_PATTERN.test(current)) {
    throw new Error("package.json version is not a stable X.Y.Z version");
  }
  const edits = [];
  for (const [relative, wanted] of JSON_VERSION_SOURCES) edits.push(jsonEdit(root, relative, wanted, current, target));
  edits.push(adapterEdit(root, current, target));
  edits.push(marketplaceEdit(root, current, target));
  const declarations = edits.reduce((total, edit) => total + edit.declarations, 0);
  if (declarations !== 6) throw new Error(`expected six version declarations, found ${declarations}`);
  return { current, edits, declarations };
}

let temporaryCounter = 0;

function writeAtomically(file, bytes, mode, hooks) {
  temporaryCounter += 1;
  const temporary = `${file}.bump-${process.pid}-${temporaryCounter}.tmp`;
  try {
    hooks.writeFile(temporary, bytes, { mode: mode & 0o7777 });
    fs.chmodSync(temporary, mode & 0o7777);
    hooks.rename(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // The temporary file is best-effort cleanup after a failed write.
    }
    throw error;
  }
}

function restoreEdits(root, edits, hooks) {
  const failures = [];
  for (const edit of [...edits].reverse()) {
    try {
      writeAtomically(path.join(root, edit.relative), edit.before, edit.mode, hooks);
    } catch (error) {
      failures.push(`${edit.relative}: ${error.message}`);
    }
  }
  return failures;
}

export function applyEdits(root, edits, hooks = {}) {
  const writer = {
    writeFile: hooks.writeFile ?? fs.writeFileSync,
    rename: hooks.rename ?? fs.renameSync,
  };
  const written = [];
  try {
    for (const edit of edits) {
      writeAtomically(path.join(root, edit.relative), edit.after, edit.mode, writer);
      written.push(edit);
    }
  } catch (error) {
    const failures = restoreEdits(root, written, writer);
    const detail = failures.length > 0 ? `rollback failed for ${failures.join(", ")}` : "all changed files were restored";
    const wrapped = new Error(`${error.message}; ${detail}`);
    wrapped.cause = error;
    throw wrapped;
  }
  return written;
}

function runChecker(root, spawn) {
  const result = spawn(process.execPath, [CHECKER_PATH, "--root", root], { encoding: "utf8" });
  if (result.error) throw new Error(`could not run check-release-versions.mjs: ${result.error.message}`);
  return result;
}

export function run(argv, hooks = {}) {
  const spawn = hooks.spawn ?? spawnSync;
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(USAGE);
    console.error(error.message);
    return 2;
  }
  let precheck;
  try {
    precheck = runChecker(options.root, spawn);
  } catch (error) {
    console.error(`Release precheck failed: ${error.message}; no files were written.`);
    return 1;
  }
  if (precheck.status !== 0) {
    process.stderr.write(precheck.stderr ?? "");
    process.stdout.write(precheck.stdout ?? "");
    console.error(`Release precheck failed for ${options.root}; no files were written.`);
    return 1;
  }
  let plan;
  try {
    plan = planEdits(options.root, options.version);
  } catch (error) {
    console.error(`Cannot prepare the release bump: ${error.message}; no files were written.`);
    return 1;
  }
  if (plan.current === options.version) {
    console.error(`Target version ${options.version} is already the current version; no files were written.`);
    return 1;
  }
  let written;
  try {
    written = applyEdits(options.root, plan.edits, hooks);
  } catch (error) {
    console.error(`Release bump failed: ${error.message}`);
    return 1;
  }
  let postcheck;
  try {
    postcheck = runChecker(options.root, spawn);
  } catch (error) {
    const failures = restoreEdits(options.root, written, {
      writeFile: hooks.writeFile ?? fs.writeFileSync,
      rename: hooks.rename ?? fs.renameSync,
    });
    console.error(`Post-write verification could not run: ${error.message}`);
    console.error(failures.length > 0 ? `Rollback failed for ${failures.join(", ")}` : "Restored every changed file.");
    return 1;
  }
  if (postcheck.status !== 0) {
    process.stderr.write(postcheck.stderr ?? "");
    process.stdout.write(postcheck.stdout ?? "");
    const failures = restoreEdits(options.root, written, {
      writeFile: hooks.writeFile ?? fs.writeFileSync,
      rename: hooks.rename ?? fs.renameSync,
    });
    console.error("Post-write verification failed.");
    console.error(failures.length > 0 ? `Rollback failed for ${failures.join(", ")}` : "Restored every changed file.");
    return 1;
  }
  console.log(`Bumped ${plan.current} -> ${options.version} across ${plan.declarations} version declarations in ${written.length} files.`);
  for (const edit of written) console.log(`- ${edit.relative}`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = run(process.argv.slice(2));
}
