// Image-eviction history continuity. Adapted from the ldfhhc fork
// (ldfhhc/omp-antigravity-acp-provider@343f29f, author junyu.zhou) and
// re-derived from the official OMP source rather than its string patches.
//
// OMP enforces a per-provider image budget on the outgoing context by DROPPING
// the oldest image blocks (user/developer/toolResult messages, in message and
// content order). Only when a message's content would become empty does it
// substitute the exact text block `[image omitted: provider image limit]`.
// That transform is one-way and leaves every non-image block untouched, so a
// warm ACP session that already absorbed the pre-eviction history is still
// valid; only the adapter's own history fingerprint changed.
//
// A checkpoint stores bounded per-message digests plus image block positions,
// ordinals and digests. It never retains image bytes, content blocks or message
// objects, and every exotic shape (proxy, accessor, sparse/custom array,
// foreign prototype) fails closed: no checkpoint is captured and no rebase is
// accepted. A changed text block, tool identity or reordered content therefore
// still forces a clean rebuild.

import { types } from "node:util";

// Exact marker emitted by OMP when an eviction empties a message.
const OMISSION_TEXT = "[image omitted: provider image limit]";
const OMISSION = Object.freeze({ type: "text", text: OMISSION_TEXT });

// Only these roles are rewritten by OMP's image clamp; an assistant image is
// never evicted, so its digest alone must match.
const CLAMPABLE_ROLES = new Set(["user", "developer", "toolResult"]);

// Bounded bookkeeping. Anything larger fails closed and rebuilds instead.
const MAX_RECORDS = 4096;
const MAX_BLOCKS = 8192;
const MAX_IMAGES = 256;

export interface ImageHistoryCheckpoint {
	readonly records: readonly ImageHistoryRecord[];
}

interface ImageHistoryRecord {
	/** Fingerprint of the accepted message. */
	readonly digest: string;
	/** Present only when the accepted content carried image blocks. */
	readonly images?: ImageSlots;
}

interface ImageSlots {
	/** Indices of the image blocks in the accepted content array, ascending. */
	readonly positions: readonly number[];
	/** Identity of each image block, in accepted order. */
	readonly digests: readonly string[];
	/** Non-image blocks preceding each image, in the same order. */
	readonly ordinals: readonly number[];
	/** Fingerprint of the accepted message with every image block removed. */
	readonly stripped: string;
	/** Fingerprint of the accepted message after the full official eviction. */
	readonly emptied: string;
	/** Fingerprint of the accepted message with only the omission marker. */
	readonly marked: string;
}

interface ImageLayout {
	readonly positions: readonly number[];
	readonly blocks: readonly unknown[];
	readonly ordinals: readonly number[];
	readonly text: readonly unknown[];
}

const EXOTIC = Symbol("exotic content");

export interface HistoryMessage {
	readonly role: string;
	readonly content: unknown;
}

/**
 * Snapshot the accepted history for later image-eviction rebasing. Returns
 * `undefined` when the history carries no clampable image, or when any shape
 * cannot be proven safe; the caller then keeps rebuilding conservatively.
 */
export function captureImageHistoryCheckpoint<T extends HistoryMessage>(
	messages: readonly T[],
	fingerprint: (message: T) => string,
): ImageHistoryCheckpoint | undefined {
	try {
		if (!Array.isArray(messages) || types.isProxy(messages) || messages.length > MAX_RECORDS) return undefined;
		let images = 0;
		for (let index = 0; index < messages.length; index++) {
			const message = read(messages, index);
			if (!CLAMPABLE_ROLES.has(message.role)) continue;
			const layout = inspectContent(message.content);
			if (layout === EXOTIC) return undefined;
			if (layout) {
				images += layout.positions.length;
				if (images > MAX_IMAGES) return undefined;
			}
		}
		if (images === 0) return undefined;
		const records: ImageHistoryRecord[] = [];
		for (let index = 0; index < messages.length; index++) {
			const message = read(messages, index);
			const digest = fingerprint(message);
			const layout = inspectContent(message.content);
			if (layout === EXOTIC) return undefined;
			if (!layout || layout.positions.length === 0 || !CLAMPABLE_ROLES.has(message.role)) {
				records.push({ digest });
				continue;
			}
			const slots: ImageSlots = {
				positions: layout.positions,
				digests: layout.blocks.map((block) => fingerprint(project(message, [block]))),
				ordinals: layout.ordinals,
				stripped: fingerprint(project(message, layout.text)),
				emptied: fingerprint(project(message, [])),
				marked: fingerprint(project(message, [OMISSION])),
			};
			records.push({ digest, images: slots });
		}
		return { records };
	} catch {
		return undefined;
	}
}

/**
 * True only when `messages` is exactly the checkpoint's history transformed by
 * OMP's one-way image eviction: zero or more of the OLDEST image blocks were
 * dropped from clampable messages, every surviving image block and every
 * non-image block is unchanged and in place, and the result is not identical.
 */
export function matchesImageHistoryCheckpoint<T extends HistoryMessage>(
	checkpoint: ImageHistoryCheckpoint | undefined,
	messages: readonly T[],
	fingerprint: (message: T) => string,
): boolean {
	try {
		if (!checkpoint || !Array.isArray(checkpoint.records) || types.isProxy(checkpoint.records)) return false;
		if (!Array.isArray(messages) || types.isProxy(messages) || messages.length === 0) return false;
		if (messages.length !== checkpoint.records.length) return false;
		let evicted = false;
		let retainedImage = false;
		for (let index = 0; index < messages.length; index++) {
			const record = read(checkpoint.records, index);
			const message = read(messages, index);
			const digest = fingerprint(message);
			if (digest === record.digest) {
				if (record.images && record.images.positions.length > 0) retainedImage = true;
				continue;
			}
			// Once any image survives, OMP's oldest-first clamp cannot evict a
			// newer one. A changed later message proves a different transform.
			if (retainedImage) return false;
			const slots = record.images;
			if (!slots) return false;
			const layout = inspectContent(message.content);
			if (layout === EXOTIC || !layout) return false;
			const kept = layout.positions.length;
			if (kept >= slots.positions.length) return false;
			if (kept === 0 && slots.emptied === slots.stripped) {
				// The content held nothing but images, so the official clamp
				// substitutes the exact omission marker (tool results always;
				// user/developer on newer OMP builds, `[]` on older ones).
				if (digest !== slots.marked && (message.role === "toolResult" || digest !== slots.emptied)) return false;
			} else {
				// Every surviving non-image block must still be identical and in
				// place; a dropped or reordered text block can never match.
				if (fingerprint(project(message, layout.text)) !== slots.stripped) return false;
				const offset = slots.positions.length - kept;
				for (let slot = 0; slot < kept; slot++) {
					if (layout.ordinals[slot] !== slots.ordinals[offset + slot]) return false;
					if (fingerprint(project(message, [layout.blocks[slot]!])) !== slots.digests[offset + slot]) return false;
				}
			}
			if (kept > 0) retainedImage = true;
			evicted = true;
		}
		return evicted;
	} catch {
		return false;
	}
}

function inspectContent(content: unknown): ImageLayout | typeof EXOTIC | undefined {
	// A string (or absent) content can never carry an image block.
	if (!Array.isArray(content)) return undefined;
	if (types.isProxy(content) || Object.getPrototypeOf(content) !== Array.prototype) return EXOTIC;
	if (content.length > MAX_BLOCKS) return EXOTIC;
	const keys = Object.getOwnPropertyNames(content);
	if (keys.length !== content.length + 1 || keys[content.length] !== "length") return EXOTIC;
	const positions: number[] = [];
	const blocks: unknown[] = [];
	const ordinals: number[] = [];
	const text: unknown[] = [];
	for (let index = 0; index < content.length; index++) {
		if (keys[index] !== String(index)) return EXOTIC;
		const descriptor = Object.getOwnPropertyDescriptor(content, index);
		if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return EXOTIC;
		const block = descriptor.value;
		if (isImageBlock(block)) {
			positions.push(index);
			blocks.push(block);
			ordinals.push(text.length);
			continue;
		}
		text.push(block);
	}
	// A valid content array with no image is still a layout: an evicted message
	// keeps its text blocks and must be comparable.
	return { positions, blocks, ordinals, text };
}

function isImageBlock(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	if (types.isProxy(value)) throw new Error("exotic block");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error("exotic block");
	const descriptor = Object.getOwnPropertyDescriptor(value, "type");
	if (!descriptor) return false;
	if (!Object.hasOwn(descriptor, "value")) throw new Error("exotic block");
	return descriptor.value === "image";
}

// The fingerprint callbacks only read role/content/tool identity, so a shallow
// copy that swaps the content array is the accepted message in its clamped
// shape. Exotic messages throw here and the caller fails closed.
function project<T extends HistoryMessage>(message: T, content: readonly unknown[]): T {
	return { ...message, content } as T;
}

function read<T>(values: readonly T[], index: number): T {
	const descriptor = Object.getOwnPropertyDescriptor(values, index);
	if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("exotic array");
	return descriptor.value as T;
}
