import type { SessionNotification } from "@agentclientprotocol/sdk";

/** Progress, not total turn duration, bounds a prompt. Outstanding work gets
 * a longer but still finite inactivity window; a lost tool update cannot hang forever. */
export class PromptWatchdog {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private holds = 0;
	private permissions = 0;
	private readonly tools = new Set<string>();
	private disposed = false;
	private fired = false;

	constructor(
		private readonly idleMs: number,
		private readonly workIdleMs: number,
		private readonly onTimeout: (busy: boolean, timeoutMs: number) => void,
	) {
		for (const value of [idleMs, workIdleMs]) {
			if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
				throw new RangeError("Prompt inactivity timeouts must be positive finite timer durations");
			}
		}
	}

	arm(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.disposed || this.fired) return;
		const busy = this.holds > 0 || this.permissions > 0 || this.tools.size > 0;
		const duration = busy ? this.workIdleMs : this.idleMs;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.disposed || this.fired) return;
			this.fired = true;
			this.onTimeout(busy, duration);
		}, duration);
		this.timer.unref?.();
	}

	noteUpdate(notification: SessionNotification): void {
		if (this.disposed || this.fired) return;
		const update = notification.update;
		if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
			if (update.status === "completed" || update.status === "failed") this.tools.delete(update.toolCallId);
			else if (update.sessionUpdate === "tool_call" || update.status === "pending" || update.status === "in_progress") {
				this.tools.add(update.toolCallId);
			}
		}
		this.arm();
	}

	hold(): () => void {
		return this.acquire("holds");
	}

	beginPermission(): () => void {
		return this.acquire("permissions");
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.tools.clear();
		this.holds = this.permissions = 0;
	}

	private acquire(kind: "holds" | "permissions"): () => void {
		if (this.disposed || this.fired) return () => undefined;
		this[kind] += 1;
		this.arm();
		let released = false;
		return () => {
			if (released || this.disposed || this.fired) return;
			released = true;
			this[kind] -= 1;
			this.arm();
		};
	}
}
