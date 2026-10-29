// OMP can dispose a temporary planning session while its provider stays registered.
// A disposed upstream runtime is terminal, so never return it to a later request.
export class SessionRuntimePool<T> {
  private readonly entries = new Map<string | undefined, T>();
  private readonly leases = new Map<T, number>();
  private readonly timers = new Map<T, NodeJS.Timeout>();
  private readonly disposing = new Set<Promise<void>>();

  constructor(
    private readonly create: () => T,
    private readonly dispose: (entry: T) => Promise<void>,
    private readonly idle: { timeoutMs: number; maxIdleEntries?: number; canDispose?: (entry: T) => boolean } = { timeoutMs: 0 },
  ) {}

  get(sessionId?: string): T {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = this.create();
      this.entries.set(sessionId, entry);
    }
    this.entries.delete(sessionId); this.entries.set(sessionId, entry);
    this.schedule(sessionId, entry);
    this.trim(entry);
    return entry;
  }

  // Inspection without instantiating: command handlers that only report
  // state must not spawn an idle ACP runtime for a fresh session.
  peek(sessionId?: string): T | undefined {
    return this.entries.get(sessionId);
  }
  acquire(sessionId?: string) {
    const value = this.get(sessionId);
    this.leases.set(value, (this.leases.get(value) ?? 0) + 1);
    this.clearTimer(value);
    let released = false;
    return { value, release: () => {
      if (released) return;
      released = true;
      const count = (this.leases.get(value) ?? 1) - 1;
      if (count > 0) this.leases.set(value, count); else this.leases.delete(value);
      if (this.entries.get(sessionId) === value) this.schedule(sessionId, value);
      this.trim();
    } };
  }
  private trim(protectedEntry?: T) {
    const cap = this.idle.maxIdleEntries ?? 0;
    if (!cap) return;
    const idle = [...this.entries].filter(([, entry]) => !this.leases.has(entry) && this.idle.canDispose?.(entry) !== false);
    let remaining = idle.length;
    for (const [key, entry] of idle) {
      if (remaining <= cap) break;
      if (entry === protectedEntry) continue;
      void this.close(key).catch(() => {});
      remaining--;
    }
  }

  private clearTimer(entry: T) {
    clearTimeout(this.timers.get(entry));
    this.timers.delete(entry);
  }

  private schedule(key: string | undefined, entry: T) {
    this.clearTimer(entry);
    if (!this.idle.timeoutMs || this.leases.has(entry)) return;
    const timer = setTimeout(() => {
      this.timers.delete(entry);
      if (this.entries.get(key) !== entry || this.leases.has(entry)) return;
      // A yielded OMP tool call can still have an ACP prompt outstanding.
      if (this.idle.canDispose?.(entry) === false) { this.schedule(key, entry); return; }
      void this.close(key).catch(() => {});
    }, this.idle.timeoutMs);
    timer.unref();
    this.timers.set(entry, timer);
  }

  values(): T[] {
    return [...this.entries.values()];
  }

  async closeIdle(sessionId?: string): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry || this.leases.has(entry) || this.idle.canDispose?.(entry) === false) return false;
    await this.close(sessionId);
    return true;
  }

  async close(sessionId?: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    // Detach before awaiting teardown so a new turn cannot reuse a closed runtime.
    this.entries.delete(sessionId);
    if (entry) {
      this.clearTimer(entry); this.leases.delete(entry);
      const pending = this.dispose(entry);
      this.disposing.add(pending);
      try { await pending; } finally { this.disposing.delete(pending); }
    }
  }

  async closeAll(): Promise<void> {
    const entries = this.values();
    this.entries.clear();
    for (const entry of entries) { this.clearTimer(entry); this.leases.delete(entry); }
    await Promise.allSettled(entries.map(entry => this.dispose(entry)));
    await Promise.allSettled(this.disposing);
  }
}
