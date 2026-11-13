// The vendored bridge's TypeBox validation stays the authority. These helpers
// only rename habitual alias arguments in fully unambiguous cases and render
// signatures for actionable error text; they never reject what Value.Check
// would accept.

const ALIAS_GROUPS: string[][] = [
  ["file_path", "path", "absolute_path", "AbsolutePath", "target_file", "TargetFile"],
  ["command", "command_line", "CommandLine"],
  ["cwd", "working_directory", "working_dir", "Cwd"],
  ["description", "Description"],
];

const MAX_ENUM_VALUES = 6;
const MAX_UNION_PARTS = 4;

export interface RenamedArgument {
  from: string;
  to: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function schemaProperties(schema: unknown): Record<string, unknown> {
  return record(record(schema)?.properties) ?? {};
}

function requiredKeys(schema: unknown): string[] {
  const required = record(schema)?.required;
  return Array.isArray(required) ? required.filter((key): key is string => typeof key === "string") : [];
}

export function normalizeToolArguments(
  schema: unknown,
  args: unknown,
): { arguments: Record<string, unknown>; renamed: RenamedArgument[] } {
  const properties = schemaProperties(schema);
  const input = record(args);
  if (!input) return { arguments: args as Record<string, unknown>, renamed: [] };
  const output: Record<string, unknown> = { ...input };
  const renamed: RenamedArgument[] = [];
  for (const group of ALIAS_GROUPS) {
    const targets = group.filter((key) => Object.hasOwn(properties, key));
    if (targets.length !== 1) continue;
    const target = targets[0];
    if (Object.hasOwn(output, target)) continue;
    const sources = group.filter((key) => key !== target && Object.hasOwn(output, key));
    if (sources.length !== 1) continue;
    const source = sources[0];
    // These aliases are only unambiguous for string fields; any other shape
    // belongs to the original validation path.
    if (record(properties[target])?.type !== "string" || typeof output[source] !== "string") continue;
    output[target] = output[source];
    delete output[source];
    renamed.push({ from: source, to: target });
  }
  return { arguments: output, renamed };
}

export function inspectToolArguments(schema: unknown, args: unknown): { missing: string[] } {
  const input = record(args) ?? {};
  const missing = requiredKeys(schema).filter((key) => !Object.hasOwn(input, key) || input[key] === undefined);
  return { missing: [...new Set(missing)] };
}

export function renderToolSignature(name: string, schema: unknown): string {
  const properties = schemaProperties(schema);
  const required = requiredKeys(schema);
  const requiredSet = new Set(required);
  const ordered = [
    ...required.filter((key, index, all) => all.indexOf(key) === index),
    ...Object.keys(properties).filter((key) => !requiredSet.has(key)),
  ];
  const parts = ordered.map((key) => `${key}${requiredSet.has(key) ? "" : "?"}: ${renderType(properties[key], 0)}`);
  return `${name}(${parts.join(", ")})`;
}

function renderType(schema: unknown, depth: number): string {
  const node = record(schema);
  if (!node) return "any";
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const values = node.enum.slice(0, MAX_ENUM_VALUES).map((value) => String(value));
    return node.enum.length > MAX_ENUM_VALUES ? `${values.join("|")}|...` : values.join("|");
  }
  const union = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined;
  if (union && union.length > 0 && depth < 2) {
    return union.slice(0, MAX_UNION_PARTS).map((part) => renderType(part, depth + 1)).join("|");
  }
  const type = node.type;
  if (type === "array") return depth < 2 ? `${renderType(node.items, depth + 1)}[]` : "array";
  if (type === "string" || type === "number" || type === "boolean" || type === "null") return type;
  return "any";
}
