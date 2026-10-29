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
		const scalars = (list ?? [candidate]) as Array<null | string | number | boolean>;
		let chars = key.length + 3;
		for (const item of scalars) chars += scalarChars(item);
		spend(budget, 0, chars);
		output[key] = list ?? candidate;
	}
	// A singleton enum also supports MCP consumers which ignore const.
	if ("const" in output && !("enum" in output)) {
		spend(budget, 0, 9 + scalarChars(output.const as null | string | number | boolean));
		output.enum = [output.const];
	}
	// Never infer a type: beside const/enum/combinators that could contradict
	// a valid typeless schema. Empty nested schemas legitimately allow anything.
	return { schema: output };
}

function jsonScalar(value: unknown): value is null | string | number | boolean {
	if (typeof value === "number") return Number.isFinite(value);
	return value === null || typeof value === "string" || typeof value === "boolean";
}
