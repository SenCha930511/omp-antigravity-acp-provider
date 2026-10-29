import fs from "node:fs";
import path from "node:path";
import { lockSync } from "proper-lockfile";

/** Serialize the entire read/modify/rename transaction across Pi processes. */
export function withStoreLock(file: string, update: () => void): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + 5_000;
	const sleeper = new Int32Array(new SharedArrayBuffer(4));
	let release: () => void;
	for (;;) {
		try {
			// The data file may not exist yet (or may have been cleared).
			// Critical sections are synchronous and short; stale locks from a
			// killed process are recoverable without deleting a live writer's lock.
			release = lockSync(file, { realpath: false, stale: 30_000 });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error;
			Atomics.wait(sleeper, 0, 0, 10);
		}
	}
	try { update(); } finally { release(); }
}
