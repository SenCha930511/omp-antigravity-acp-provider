import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";

/** Only parsed JSON is valid Pi tool input; reject lossy/non-serializable values. */
export function isJsonObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value, 0);
}

function isJsonValue(value: unknown, depth: number): value is JsonValue {
	if (depth > 100) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}
