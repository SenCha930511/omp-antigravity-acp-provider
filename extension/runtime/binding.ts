// Binding checkpoint fingerprints. The runtime compares OMP history against
// what it last sent to one ACP binding, so these memos must never retain a live
// host container or an executable tool closure.
import { types } from "node:util";

const OBJECT = Symbol("object"), NULL_OBJECT = Symbol("null object"), ARRAY = Symbol("array"), FUNCTION = Symbol("function");
const MAX_NODES = 32768, MAX_TOKENS = 131072, MAX_CHARS = 2 * 1024 * 1024;
const FUNCTION_PROTOTYPES = new Set([Function.prototype, Object.getPrototypeOf(async () => {}),
  Object.getPrototypeOf(function* () {}), Object.getPrototypeOf(async function* () {})]);

// One entry per cache, owned by one runtime. Primitive tokens are independent
// of host container identity.
export function createStructuredFingerprintMemo() {
  let tokens: unknown[] | undefined, digest: string | undefined;
  function visit(value: unknown, put: (token: unknown) => void, budget: { nodes: number; chars: number }, seen: Set<object>): void {
    if (++budget.nodes > MAX_NODES) throw new Error("snapshot node budget");
    if (typeof value === "function") {
      if (types.isProxy(value) || !FUNCTION_PROTOTYPES.has(Object.getPrototypeOf(value)) || "toJSON" in value) throw new Error("exotic function");
      put(FUNCTION); return; // Canonical JSON emits null for ordinary functions.
    }
    if (value === null || typeof value !== "object") {
      if (typeof value === "symbol" || typeof value === "bigint") throw new Error("unsupported primitive");
      if (typeof value === "string" && (budget.chars += value.length) > MAX_CHARS) throw new Error("snapshot string budget");
      put(value); return;
    }
    if (types.isProxy(value)) throw new Error("proxy");
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (seen.has(value) || (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) ||
        Object.getOwnPropertySymbols(value).length) throw new Error("unsupported container");
    seen.add(value);
    // Schema projection examines non-enumerable properties too. Capture both
    // names and enumerable flags, not just JSON-visible object fields.
    const keys = Object.getOwnPropertyNames(value);
    if (keys.length > MAX_NODES) throw new Error("snapshot key budget");
    if (array && (keys.length !== value.length + 1 || keys.at(-1) !== "length")) throw new Error("custom/sparse array");
    put(array ? ARRAY : prototype === null ? NULL_OBJECT : OBJECT); put(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (array && i < keys.length - 1 && key !== String(i)) throw new Error("sparse array");
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor)) throw new Error("accessor");
      if ((budget.chars += key.length) > MAX_CHARS) throw new Error("snapshot string budget");
      put(key); put(descriptor.enumerable); visit(descriptor.value, put, budget, seen);
    }
  }
  const clear = () => { tokens = undefined; digest = undefined; };
  const memo = (value: unknown, compute: () => string): string => {
    if (tokens) {
      let index = 0;
      try {
        visit(value, token => { if (!Object.is(token, tokens![index++])) throw new Error("changed"); }, { nodes: 0, chars: 0 }, new Set());
        if (index === tokens.length) return digest!;
      } catch { /* Revalidate/recompute every changed or unsupported payload. */ }
    }
    clear();
    let next: unknown[] | undefined = [];
    try {
      visit(value, token => { if (next!.length >= MAX_TOKENS) throw new Error("snapshot token budget"); next!.push(token); },
        { nodes: 0, chars: 0 }, new Set());
    } catch { next = undefined; }
    const result = compute();
    tokens = next; digest = next ? result : undefined;
    return result;
  };
  return Object.assign(memo, { clear });
}

// Cache only large, simple payloads. Identity locates an entry; the live values
// must still match an independent snapshot before its digest can be reused.
const UNSUPPORTED = Symbol("unsupported snapshot");
const MIN_STRING = 2048;
const MAX_MESSAGE_NODES = 128;
type Snapshot = { value: unknown; digest: string };

function worthCaching(content: unknown): boolean {
  if (typeof content === "string") return content.length >= MIN_STRING;
  if (!Array.isArray(content) || types.isProxy(content)) return false;
  for (let i = 0; i < Math.min(content.length, 32); i++) {
    const block = Object.getOwnPropertyDescriptor(content, String(i))?.value;
    if (!block || typeof block !== "object" || types.isProxy(block)) continue;
    for (const key of ["text", "data", "thinking"]) {
      const value = Object.getOwnPropertyDescriptor(block, key)?.value;
      if (typeof value === "string" && value.length >= MIN_STRING) return true;
    }
  }
  return false;
}

// Snapshot construction never retains a live mutable container or invokes an
// accessor. Reject exotic prototypes, aliases/cycles and sparse/custom arrays.
function snapshot(value: unknown, budget = { nodes: 0 }, seen = new Set<object>()): unknown {
  if (++budget.nodes > MAX_MESSAGE_NODES) return UNSUPPORTED;
  if (value === null || typeof value !== "object") {
    return ["function", "symbol", "bigint"].includes(typeof value) ? UNSUPPORTED : value;
  }
  const array = Array.isArray(value);
  if (types.isProxy(value) || seen.has(value) || Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) return UNSUPPORTED;
  seen.add(value);
  const keys = Object.keys(value);
  if (keys.length > MAX_MESSAGE_NODES || (array && (keys.length !== value.length ||
      Object.getOwnPropertyNames(value).length !== keys.length + 1))) return UNSUPPORTED;
  const result = array ? [] : Object.create(null);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (array && key !== String(i)) return UNSUPPORTED;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!Object.hasOwn(descriptor, "value")) return UNSUPPORTED;
    const child = snapshot(descriptor.value, budget, seen);
    if (child === UNSUPPORTED) return UNSUPPORTED;
    result[key] = child;
  }
  return result;
}

function matches(value: unknown, saved: unknown, budget = { nodes: 0 }): boolean {
  if (++budget.nodes > MAX_MESSAGE_NODES) return false;
  if (value === null || typeof value !== "object") return Object.is(value, saved);
  const array = Array.isArray(value);
  if (types.isProxy(value) || !saved || typeof saved !== "object" || array !== Array.isArray(saved) ||
      Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) return false;
  const keys = Object.keys(value);
  if (keys.length > MAX_MESSAGE_NODES || keys.length !== Object.keys(saved).length ||
      (Array.isArray(value) && Array.isArray(saved) && (value.length !== saved.length || Object.getOwnPropertyNames(value).length !== keys.length + 1))) return false;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!Object.hasOwn(descriptor, "value") || !Object.hasOwn(saved, key) ||
        !matches(descriptor.value, Reflect.get(saved, key), budget)) return false;
  }
  return true;
}

export function createHistoryFingerprintMemo() {
  const entries = new WeakMap<object, Snapshot>();
  return (message: object, value: unknown, compute: () => string): string => {
    const previous = entries.get(message);
    if (previous && matches(value, previous.value)) return previous.digest;
    // Drop stale strings even if canonical serialization subsequently throws.
    if (previous) entries.delete(message);
    if (!value || typeof value !== "object" || !worthCaching(Reflect.get(value, "content"))) return compute();
    const saved = snapshot(value);
    const digest = compute();
    if (saved !== UNSUPPORTED) entries.set(message, { value: saved, digest });
    return digest;
  };
}
