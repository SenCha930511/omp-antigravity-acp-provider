// OMP filters its `/model` picker through `enabledModels` in the agent
// config. A whitelist that names only other providers hides every model this
// adapter advertises, so refresh appends one provider-wide selector. Parsing
// is deliberately narrow: an unrecognized shape is left untouched rather than
// rewritten into something OMP cannot load.
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { lockFile } from "./runtime.mjs";
import { isMissingFileError } from "./fs-atomic.ts";

export const PROVIDER_MODEL_SELECTOR = "antigravity-acp-provider/*";

export type WhitelistUpdateReason = "updated" | "already-enabled" | "no-whitelist" | "empty-whitelist" | "unsupported";

export interface WhitelistUpdate {
  readonly text: string;
  readonly changed: boolean;
  readonly reason: WhitelistUpdateReason;
  // Entries read from the file. An `updated` result lists the appended
  // selector too, so a caller can report the whitelist it now contains.
  readonly entries: readonly string[];
}

export interface WhitelistFileUpdate {
  readonly path: string;
  readonly changed: boolean;
  readonly reason: WhitelistUpdateReason;
  readonly entries: readonly string[];
}

const KEY_PATTERN = /^enabledModels[ \t]*:/;

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function lineBody(line: string): string {
  return line.endsWith("\n") ? line.slice(0, line.endsWith("\r\n") ? -2 : -1) : line;
}

function unchanged(text: string, reason: WhitelistUpdateReason, entries: readonly string[] = []): WhitelistUpdate {
  return { text, changed: false, reason, entries };
}

// A `#` starts a comment only at the beginning or after whitespace, so
// `gemini#1` stays a scalar while `gemini # note` loses the note.
function stripInlineComment(raw: string): string | undefined {
  let quote: string | undefined;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!;
    if (quote) {
      if (char === "\\" && quote === '"') {
        index++;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /[ \t]/.test(raw[index - 1]!))) return raw.slice(0, index);
  }
  return quote ? undefined : raw;
}

function unquote(value: string): string | undefined {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return /^["']/.test(value) ? undefined : value;
  let out = "";
  for (let index = 1; index < value.length; index++) {
    const char = value[index]!;
    if (quote === '"' && char === "\\") {
      const escaped = value[index + 1];
      if (escaped !== '"' && escaped !== "\\") return undefined;
      out += escaped;
      index++;
      continue;
    }
    if (char === quote) {
      if (quote === "'" && value[index + 1] === "'") {
        out += "'";
        index++;
        continue;
      }
      return index === value.length - 1 ? out : undefined;
    }
    out += char;
  }
  return undefined;
}

function isPlainScalar(value: string): boolean {
  if (/^["']/.test(value)) return true;
  if (value === "-" || /^-[ \t]/.test(value)) return false;
  if (/^[[{&*!|>]/.test(value)) return false;
  return !/:(?:[ \t]|$)/.test(value);
}

function parseScalar(raw: string): string | undefined {
  const withoutComment = stripInlineComment(raw);
  if (withoutComment === undefined) return undefined;
  const value = withoutComment.trim();
  if (!value || !isPlainScalar(value)) return undefined;
  return unquote(value);
}

function splitFlowItems(content: string): string[] | undefined {
  const items: string[] = [];
  let quote: string | undefined;
  let current = "";
  for (let index = 0; index < content.length; index++) {
    const char = content[index]!;
    if (quote) {
      current += char;
      if (char === "\\" && quote === '"') {
        current += content[++index] ?? "";
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      items.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (quote) return undefined;
  items.push(current);
  return items;
}

function parseFlowEntries(text: string, open: number): { entries: string[]; close: number } | undefined {
  let quote: string | undefined;
  let close = -1;
  for (let index = open + 1; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === "\\" && quote === '"') {
        index++;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    // Comments, nested collections and unterminated lists are shapes this
    // module cannot edit without risking the rest of the document.
    if (char === "#" || char === "[" || char === "{" || char === "}") return undefined;
    if (char === "]") {
      close = index;
      break;
    }
  }
  if (close < 0) return undefined;
  const lineEnd = text.indexOf("\n", close);
  const tail = text.slice(close + 1, lineEnd < 0 ? text.length : lineEnd);
  if (!/^[ \t\r]*(#.*)?$/.test(tail)) return undefined;
  const items = splitFlowItems(text.slice(open + 1, close));
  if (!items) return undefined;
  const entries: string[] = [];
  for (let index = 0; index < items.length; index++) {
    const value = items[index]!.trim();
    if (!value) {
      if (index === items.length - 1) continue;
      return undefined;
    }
    const parsed = parseScalar(value);
    if (parsed === undefined) return undefined;
    entries.push(parsed);
  }
  return { entries, close };
}

export function enableProviderInWhitelist(text: string, provider = "antigravity-acp-provider"): WhitelistUpdate {
  const prefix = `${provider}/`;
  const selector = `${prefix}*`;
  const lines = splitLines(text);
  const keys = lines.flatMap((line, index) => KEY_PATTERN.test(lineBody(line)) ? [index] : []);
  // Duplicate keys make the effective whitelist ambiguous, so neither wins.
  if (keys.length === 0) return unchanged(text, "no-whitelist");
  if (keys.length > 1) return unchanged(text, "unsupported");
  const keyIndex = keys[0]!;
  const body = lineBody(lines[keyIndex]!);
  const keyMatch = KEY_PATTERN.exec(body)!;
  const inline = body.slice(keyMatch[0].length);
  const trimmed = inline.trim();

  if (trimmed === "" || trimmed.startsWith("#")) return enableBlockList(text, lines, keyIndex, prefix, selector);
  if (trimmed === "null" || trimmed === "~") return unchanged(text, "empty-whitelist");
  if (!trimmed.startsWith("[")) return unchanged(text, "unsupported");

  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length;
  }
  const open = offsets[keyIndex]! + keyMatch[0].length + inline.indexOf("[");
  const flow = parseFlowEntries(text, open);
  if (!flow) return unchanged(text, "unsupported");
  if (flow.entries.length === 0) return unchanged(text, "empty-whitelist", flow.entries);
  if (flow.entries.some(entry => entry.startsWith(prefix))) return unchanged(text, "already-enabled", flow.entries);
  const beforeClose = text.slice(open + 1, flow.close);
  const trimmedBefore = beforeClose.trimEnd();
  const separator = trimmedBefore === "" ? "" : trimmedBefore.endsWith(",") ? " " : ", ";
  // Land after the last entry rather than after a trailing newline, so a
  // multiline list keeps its closing bracket on its own line.
  const at = open + 1 + trimmedBefore.length;
  return {
    text: `${text.slice(0, at)}${separator}"${selector}"${text.slice(at)}`,
    changed: true,
    reason: "updated",
    entries: [...flow.entries, selector],
  };
}

function enableBlockList(text: string, lines: string[], keyIndex: number, prefix: string, selector: string): WhitelistUpdate {
  const entries: string[] = [];
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let indent = "";
  let lastItem = -1;
  for (let index = keyIndex + 1; index < lines.length; index++) {
    const body = lineBody(lines[index]!);
    if (body.trim() === "") continue;
    const content = body.trim();
    if (content.startsWith("#")) continue;
    const item = content === "-" || /^-[ \t]/.test(content);
    if (!/^[ \t]/.test(body) && !item) break;
    if (!item) return unchanged(text, "unsupported");
    const value = parseScalar(content.slice(1));
    if (value === undefined) return unchanged(text, "unsupported");
    if (lastItem < 0) indent = body.slice(0, body.length - body.trimStart().length);
    entries.push(value);
    lastItem = index;
  }
  if (lastItem < 0) return unchanged(text, "empty-whitelist", entries);
  if (entries.some(entry => entry.startsWith(prefix))) return unchanged(text, "already-enabled", entries);

  const insertion = `${indent}- "${selector}"`;
  const updated = [...lines];
  const previous = updated[lastItem]!;
  if (previous.endsWith("\n")) {
    updated.splice(lastItem + 1, 0, `${insertion}${previous.endsWith("\r\n") ? "\r\n" : "\n"}`);
  } else {
    updated[lastItem] = `${previous}${eol}${insertion}`;
  }
  return { text: updated.join(""), changed: true, reason: "updated", entries: [...entries, selector] };
}

export function resolveOmpConfigPath(agentDir: string): string | undefined {
  for (const name of ["config.yml", "config.yaml"]) {
    const candidate = path.join(agentDir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }
  return undefined;
}

export async function ensureProviderModelsEnabled(file: string, provider?: string): Promise<WhitelistFileUpdate> {
  const requested = path.resolve(file);
  let target: string;
  try {
    target = await fsPromises.realpath(requested);
  } catch (error) {
    if (isMissingFileError(error)) return { path: requested, changed: false, reason: "no-whitelist", entries: [] };
    throw error;
  }
  let mode: number;
  try {
    mode = (await fsPromises.stat(target)).mode & 0o777;
  } catch (error) {
    if (isMissingFileError(error)) return { path: requested, changed: false, reason: "no-whitelist", entries: [] };
    throw error;
  }
  let compromised: Error | undefined;
  const release = await lockFile(target, {
    realpath: false,
    stale: 30_000,
    retries: 0,
    onCompromised: error => { compromised = error; },
  });
  try {
    const update = enableProviderInWhitelist(await fsPromises.readFile(target, "utf8"), provider);
    if (compromised) throw compromised;
    if (!update.changed) return { path: requested, changed: false, reason: update.reason, entries: update.entries };
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fsPromises.writeFile(temporary, update.text, { mode });
      await fsPromises.chmod(temporary, mode);
      if (compromised) throw compromised;
      await fsPromises.rename(temporary, target);
    } finally {
      await fsPromises.rm(temporary, { force: true });
    }
    return { path: requested, changed: true, reason: update.reason, entries: update.entries };
  } finally {
    await release().catch(() => {});
  }
}
