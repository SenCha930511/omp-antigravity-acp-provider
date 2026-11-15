import { types } from "node:util";

// Adapted from robertvitali's 8481e20 schema projection, preserving Pi's
// original call-time validation and structured omission/fingerprint contracts.
const SCHEMA_LIMIT = 64 * 1024;
const MAX_SCHEMA_WORK = 100_000;
const MAX_SCHEMA_DEPTH = 16;

type SchemaOmissionReason =
	| "unsupported_keyword"
	| "invalid_keyword_value"
	| "unsafe_property_name"
	| "too_deep"
	| "cyclic_schema"
	| "not_object"
	| "too_large";

type Projection = { schema: Record<string, unknown> } | { reason: SchemaOmissionReason };

/** Project only representable constraints. Failure omits one whole tool, never
 * silently widens its advertised input schema or prevents other tools loading. */
export function projectToolSchema(value: unknown): Projection {
	try {
		const projected = sanitizeSchema(value, 0, {
			work: MAX_SCHEMA_WORK, chars: SCHEMA_LIMIT, ancestors: new WeakSet(),
		});
		if ("reason" in projected) return projected;
		if (projected.schema.type !== "object") return { reason: "not_object" };
		if (Buffer.byteLength(JSON.stringify(projected.schema), "utf8") > SCHEMA_LIMIT) return { reason: "too_large" };
		return projected;
	} catch (error) {
		return { reason: error instanceof SchemaBudgetExceeded ? "too_large" : "unsupported_keyword" };
	}
}

/** Depth alone cannot bound a shared acyclic graph: fan-out 4 at depth 16
 * otherwise visits 4^16 paths. Charge visits, keys, array elements and a lower
 * bound on JSON output before allocating descendants. Track only ancestors,
 * so small shared subschemas remain valid while cycles fail on first re-entry. */
interface ProjectionBudget {
	work: number;
	chars: number;
	readonly ancestors: WeakSet<object>;
}
class SchemaBudgetExceeded extends Error {}
function spend(budget: ProjectionBudget, work: number, chars = 0): void {
	budget.work -= work;
	budget.chars -= chars;
	if (budget.work < 0 || budget.chars < 0) throw new SchemaBudgetExceeded();
}
function scalarChars(value: null | string | number | boolean): number {
	return typeof value === "string" ? value.length + 2 : String(value).length;
}

/** Snapshot ordinary arrays without invoking iterators, getters or proxy
 * traps. Charge the stable data-descriptor length before copying elements. */
function snapshotArray(value: unknown, budget: ProjectionBudget): unknown[] | SchemaOmissionReason {
	if (types.isProxy(value)) return "unsupported_keyword";
	if (!Array.isArray(value)) return "invalid_keyword_value";
	if (Object.getPrototypeOf(value) !== Array.prototype) return "unsupported_keyword";
	if (Object.getOwnPropertySymbols(value).length > 0) return "unsupported_keyword";
	const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return "unsupported_keyword";
	spend(budget, length);
	const copy: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor) return "invalid_keyword_value";
		if (!("value" in descriptor)) return "unsupported_keyword";
		copy.push(descriptor.value);
	}
	return copy;
}

// Only annotations may be dropped. Unknown validation keywords reject the tool.
const ANNOTATION_KEYS = new Set(["$schema", "$id", "$comment", "examples", "deprecated", "readOnly", "writeOnly"]);
const METADATA_KEYS = new Set([...ANNOTATION_KEYS, "title", "description", "default"]);
const STRING_KEYS = new Set(["title", "description", "format", "pattern"]);
const NUMBER_KEYS = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]);
const COUNT_KEYS = new Set(["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]);
const JSON_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
// These TypeBox markers carry no constraints beyond the JSON beside them.
const HIDDEN_KEYS = new Set(["~kind", "~optional", "~readonly", "~immutable", "~unsafe"]);
const KNOWN_KINDS = new Set([
	"Object", "Array", "String", "Number", "Integer", "Boolean", "Null", "Literal",
	"Union", "Intersect", "Enum", "Unknown", "Any",
]);

/** Include non-enumerable keys (TypeBox validators can be hidden), but reject
 * custom prototypes, symbols and accessors rather than losing their semantics. */
function plainEntries(value: object, budget: ProjectionBudget): Array<[string, unknown]> | undefined {
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
	const names = Object.getOwnPropertyNames(value);
	spend(budget, names.length);
	const entries: Array<[string, unknown]> = [];
	for (const key of names) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) return undefined;
		entries.push([key, descriptor.value]);
	}
	return entries;
}

// agy compiles every projected `pattern` with Go's RE2 engine, while JSON
// Schema patterns are ECMA-262: Unicode escapes and lookarounds make agy fail
// "building toolbox" and abort the whole turn before any model call. Translate
// the escapes RE2 can express, keep a pattern only when nothing RE2 cannot
// express (or would reinterpret) remains, and otherwise drop the field while
// preserving the original as a description hint for the model.
const PATTERN_HINT_PREFIX = "pattern: ";
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

function isHighSurrogate(cp: number): boolean {
	return cp >= HIGH_SURROGATE_START && cp <= HIGH_SURROGATE_END;
}

function isLowSurrogate(cp: number): boolean {
	return cp >= LOW_SURROGATE_START && cp <= LOW_SURROGATE_END;
}

function joinSurrogates(high: number, low: number): number {
	return 0x10000 + ((high - HIGH_SURROGATE_START) << 10) + (low - LOW_SURROGATE_START);
}

// Recognizes `\uXXXX` and `\u{...}` starting at `index`.
function parseUnicodeEscape(source: string, index: number): { end: number; cp: number } | undefined {
	if (source[index] !== "\\") return undefined;
	const rest = source.slice(index + 1);
	let match = /^u\{([0-9a-fA-F]+)\}/.exec(rest);
	if (match) return { end: index + 1 + match[0].length, cp: Number.parseInt(match[1]!, 16) };
	match = /^u([0-9a-fA-F]{4})/.exec(rest);
	if (match) return { end: index + 1 + match[0].length, cp: Number.parseInt(match[1]!, 16) };
	return undefined;
}

function emitCodePoint(cp: number): string {
	const digits = cp.toString(16).toUpperCase();
	return `\\x{${cp <= 0xffff ? digits.padStart(4, "0") : digits}}`;
}

// Escape-aware translation of ECMA-262 Unicode escapes into RE2 `\x{...}`
// escapes, joining adjacent UTF-16 surrogate pairs (escaped or raw) into one
// code point so an astral pattern character stays a single RE2 atom.
// `\\u00e9` (a literal backslash before the letters u00e9) is left alone, and
// the `\x{...}` output is never re-translated, so the rewrite is idempotent.
function translateUnicodeEscapes(source: string): string {
	let out = "";
	let index = 0;
	while (index < source.length) {
		const parsed = parseUnicodeEscape(source, index);
		if (parsed) {
			const next = parseUnicodeEscape(source, parsed.end);
			if (isHighSurrogate(parsed.cp) && next && isLowSurrogate(next.cp)) {
				out += emitCodePoint(joinSurrogates(parsed.cp, next.cp));
				index = next.end;
				continue;
			}
			// An escaped high surrogate followed by a raw low surrogate.
			if (isHighSurrogate(parsed.cp) && isLowSurrogate(source.charCodeAt(parsed.end))) {
				out += emitCodePoint(joinSurrogates(parsed.cp, source.charCodeAt(parsed.end)));
				index = parsed.end + 1;
				continue;
			}
			out += emitCodePoint(parsed.cp);
			index = parsed.end;
			continue;
		}
		if (source[index] === "\\") {
			out += source[index++]!;
			if (index < source.length) out += source[index++]!;
			continue;
		}
		const code = source.charCodeAt(index);
		if (isHighSurrogate(code)) {
			const next = parseUnicodeEscape(source, index + 1);
			if (next && isLowSurrogate(next.cp)) {
				out += emitCodePoint(joinSurrogates(code, next.cp));
				index = next.end;
				continue;
			}
			if (isLowSurrogate(source.charCodeAt(index + 1))) {
				out += emitCodePoint(joinSurrogates(code, source.charCodeAt(index + 1)));
				index += 2;
				continue;
			}
		}
		out += source[index++]!;
	}
	return out;
}

// Only these escape letters keep their JavaScript meaning in RE2. Everything
// else after a backslash is rejected: `\u`/`\U`/`\c` are invalid there,
// backreferences `\1`-`\9` and `\k<name>` do not exist, and letters like `\a`
// (BEL), `\A`, `\z`, `\K`, `\Q…\E`, `\e` change or lose their meaning. A
// digit is never safe (RE2 reads octal, JavaScript reads a backreference), and
// a lone trailing backslash is invalid in both engines.
const RE2_SAFE_ESCAPE_LETTERS = new Set(["f", "n", "r", "t", "v", "d", "D", "s", "S", "w", "W", "b", "B", "x", "p", "P", "0"]);

// Lookaheads `(?=` / `(?!` and lookbehinds `(?<=` / `(?<!` have no RE2 form.
// `(?<name>` groups are fine and stay.
function isRE2Safe(source: string): boolean {
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (char === "\\") {
			const next = source[++index];
			if (next === undefined) return false;
			if (/[a-zA-Z0-9]/u.test(next) && !RE2_SAFE_ESCAPE_LETTERS.has(next)) return false;
			continue;
		}
		if (char === "(" && source[index + 1] === "?") {
			const ahead = source[index + 2];
			if (ahead === "=" || ahead === "!") return false;
			if (ahead === "<" && (source[index + 3] === "=" || source[index + 3] === "!")) return false;
		}
	}
	return true;
}

// The RE2-safe rewrite of a pattern, or undefined when it must be dropped.
function toRE2Pattern(original: string): string | undefined {
	const translated = translateUnicodeEscapes(original);
	return isRE2Safe(translated) ? translated : undefined;
}

// Bridge-style hint: appended in parentheses after an existing description,
// standing alone when there was none. Re-projecting a hinted node is a no-op.
function appendPatternHint(node: Record<string, unknown>, hint: string, budget: ProjectionBudget): void {
	const description = node.description;
	if (typeof description === "string" && description.trim() && !description.includes(hint)) {
		node.description = `${description} (${hint})`;
		spend(budget, 0, hint.length + 3);
	} else if (typeof description !== "string" || !description.trim()) {
		node.description = hint;
		spend(budget, 0, hint.length + 2);
	}
}

function sanitizeSchema(value: unknown, depth: number, budget: ProjectionBudget): Projection {
	if (depth > MAX_SCHEMA_DEPTH) return { reason: "too_deep" };
	if (!value || typeof value !== "object") return { reason: "invalid_keyword_value" };
	if (types.isProxy(value)) return { reason: "unsupported_keyword" };
	if (Array.isArray(value)) return { reason: "invalid_keyword_value" };
	if (budget.ancestors.has(value)) return { reason: "cyclic_schema" };
	spend(budget, 1, 2);
	budget.ancestors.add(value);
	try {
		return sanitizeNode(value, depth, budget);
	} finally {
		budget.ancestors.delete(value);
	}
}

function sanitizeNode(value: object, depth: number, budget: ProjectionBudget): Projection {
	const entries = plainEntries(value, budget);
	if (!entries) return { reason: "unsupported_keyword" };
	const output: Record<string, unknown> = {};
	let typeUnion: string[] | undefined;
	let patternHint: string | undefined;
	for (const [key, candidate] of entries) {
		if (key.startsWith("~")) {
			if (!HIDDEN_KEYS.has(key)) return { reason: "unsupported_keyword" };
			if (key === "~kind" && !(typeof candidate === "string" && KNOWN_KINDS.has(candidate))) {
				return { reason: "unsupported_keyword" };
			}
			continue;
		}
		if (candidate === undefined && METADATA_KEYS.has(key)) continue;
		if (ANNOTATION_KEYS.has(key)) continue;
		if (key === "default") {
			// Defaults are annotations, not constraints. Never walk non-scalar
			// defaults: they can contain arbitrary cycles or executable objects.
			if (jsonScalar(candidate)) {
				spend(budget, 0, key.length + 3 + scalarChars(candidate));
				output.default = candidate;
			}
			continue;
		}
		if (key === "pattern") {
			if (typeof candidate !== "string") return { reason: "invalid_keyword_value" };
			const rewritten = toRE2Pattern(candidate);
			if (rewritten === undefined) {
				patternHint = `${PATTERN_HINT_PREFIX}${candidate}`;
			} else {
				spend(budget, 0, key.length + 3 + scalarChars(rewritten));
				output.pattern = rewritten;
			}
			continue;
		}
		if (key === "properties") {
			if (types.isProxy(candidate)) return { reason: "unsupported_keyword" };
			if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
				return { reason: "invalid_keyword_value" };
			}
			const propertyEntries = plainEntries(candidate, budget);
			if (!propertyEntries) return { reason: "invalid_keyword_value" };
			spend(budget, 0, key.length + 5);
			const properties: Record<string, unknown> = {};
			for (const [name, schema] of propertyEntries) {
				if (name === "__proto__") return { reason: "unsafe_property_name" };
				spend(budget, 0, name.length + 3);
				const sanitized = sanitizeSchema(schema, depth + 1, budget);
				if ("reason" in sanitized) return sanitized;
				properties[name] = sanitized.schema;
			}
			output.properties = properties;
			continue;
		}
		if (key === "items" || (key === "additionalProperties" && typeof candidate !== "boolean")) {
			spend(budget, 0, key.length + 3);
			const sanitized = sanitizeSchema(candidate, depth + 1, budget);
			if ("reason" in sanitized) return sanitized;
			output[key] = sanitized.schema;
			continue;
		}
		if (key === "anyOf" || key === "oneOf" || key === "allOf") {
			const members = snapshotArray(candidate, budget);
			if (typeof members === "string") return { reason: members };
			if (members.length === 0) return { reason: "invalid_keyword_value" };
			spend(budget, 0, key.length + 5);
			const variants: Record<string, unknown>[] = [];
			for (const item of members) {
				const sanitized = sanitizeSchema(item, depth + 1, budget);
				if ("reason" in sanitized) return sanitized;
				variants.push(sanitized.schema);
			}
			output[key] = variants;
			continue;
		}
		let list: unknown[] | undefined;
		if (key === "enum" || key === "required" || (key === "type" && typeof candidate === "object" && candidate !== null)) {
			const snapshot = snapshotArray(candidate, budget);
			if (typeof snapshot === "string") return { reason: snapshot };
			list = snapshot;
		}
		let valid: boolean;
		if (STRING_KEYS.has(key)) valid = typeof candidate === "string";
		else if (NUMBER_KEYS.has(key)) valid = typeof candidate === "number" && Number.isFinite(candidate);
		else if (key === "multipleOf") valid = typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0;
		else if (COUNT_KEYS.has(key)) valid = Number.isSafeInteger(candidate) && (candidate as number) >= 0;
		else if (key === "uniqueItems" || key === "additionalProperties") valid = typeof candidate === "boolean";
		else if (key === "const") valid = jsonScalar(candidate);
		else if (key === "type") {
			valid = (typeof candidate === "string" && JSON_TYPES.has(candidate)) ||
				(list !== undefined && list.length > 0 && list.every((item) => typeof item === "string" && JSON_TYPES.has(item)));
		} else if (key === "enum") valid = list !== undefined && list.length > 0 && list.every(jsonScalar);
		else if (key === "required") valid = list !== undefined && list.every((item) => typeof item === "string");
		else return { reason: "unsupported_keyword" };
		if (!valid) return { reason: "invalid_keyword_value" };
		if (key === "type" && list !== undefined) {
			// Deduplicate the validated names before emission: a singleton
			// projects to one scalar string, while genuine unions
			// are composed after every keyword is known so existing combinators
			// stay intact regardless of property order.
			const names: string[] = [];
			for (const item of list) {
				if (typeof item === "string" && !names.includes(item)) names.push(item);
			}
			if (names.length === 1) {
				const name = names[0];
				spend(budget, 0, key.length + 3 + scalarChars(name));
				output.type = name;
			} else {
				// Nullable unions must retain null as a semantic alternative. A
				// single concrete type is not an equivalent projection.
				typeUnion = names;
			}
			continue;
		}
		const scalars = (list ?? [candidate]) as Array<null | string | number | boolean>;
		let chars = key.length + 3;
		for (const item of scalars) chars += scalarChars(item);
		spend(budget, 0, chars);
		output[key] = list ?? candidate;
	}
	if (typeUnion) {
		const members = typeUnion.map((name) => ({ type: name }));
		const clause = { anyOf: members };
		if ("anyOf" in output) {
			const existing = output.allOf;
			output.allOf = Array.isArray(existing) ? [...existing, clause] : [clause];
			spend(budget, members.length, JSON.stringify(clause).length + (Array.isArray(existing) ? 1 : 10));
		} else {
			output.anyOf = members;
			spend(budget, members.length, JSON.stringify(clause).length);
		}
	}
	// A singleton enum also supports MCP consumers which ignore const.
	if ("const" in output && !("enum" in output)) {
		spend(budget, 0, 9 + scalarChars(output.const as null | string | number | boolean));
		output.enum = [output.const];
	}
	if (patternHint !== undefined) appendPatternHint(output, patternHint, budget);
	// Never infer a type: beside const/enum/combinators that could contradict
	// a valid typeless schema. Empty nested schemas legitimately allow anything.
	return { schema: output };
}

function jsonScalar(value: unknown): value is null | string | number | boolean {
	if (typeof value === "number") return Number.isFinite(value);
	return value === null || typeof value === "string" || typeof value === "boolean";
}
