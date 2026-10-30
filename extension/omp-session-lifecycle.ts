export interface OmpProviderSessionState { close(): void; releaseSession?(sessionId: string): void }
type RoutingId = string | undefined;
interface Ticket { id: RoutingId; closed: boolean; users: number; scope: Scope; bundle?: object }
interface Scope extends OmpProviderSessionState {
  closed: boolean; sessions: Map<RoutingId, Ticket>; retainedIds: Set<RoutingId>; predecessor?: Promise<void>; closing?: Promise<void>;
}

// OMP can rotate provider routing identity without changing its transcript ID
// (/fresh, reset), and side requests have their own routing IDs. Honor the
// host's lifecycle contract instead of inferring ownership from UI events.
export class OmpSessionLifecycle {
  private readonly scopes = new WeakMap<Map<string, OmpProviderSessionState>, Scope>();
  private readonly tickets = new Map<RoutingId, Set<Ticket>>();
  private readonly bundles = new WeakMap<object, Set<Ticket>>();
  private readonly closing = new Map<RoutingId, Promise<void>>();
  private readonly fallback = this.newScope();

  constructor(private readonly closeRuntime: (id: RoutingId) => Promise<void>,
    private readonly releaseRuntime: (id: RoutingId) => Promise<void> = async () => {}) {}

  private newScope(predecessor?: Promise<void>): Scope {
    // Observe failures immediately; ready() still surfaces them before dispatch.
    void predecessor?.catch(() => {});
    const scope: Scope = { closed: false, sessions: new Map(), retainedIds: new Set(), predecessor,
      close: () => {
        if (scope.closing) return scope.closing;
        scope.closed = true;
        const ids = new Set([...scope.sessions.keys(), ...scope.retainedIds]);
        scope.retainedIds.clear();
        return scope.closing = Promise.allSettled([...ids].map(id => this.closeSession(id))).then(() => {});
      },
      releaseSession: id => {
        if (scope.sessions.has(id) || scope.retainedIds.has(id)) {
          scope.retainedIds.delete(id);
          void this.closeSession(id, true).catch(() => {});
        }
      },
    };
    return scope;
  }

  capture(id: RoutingId, host?: Map<string, OmpProviderSessionState>): Ticket {
    let scope = this.fallback;
    if (host) {
      const previous = this.scopes.get(host);
      if (previous && !previous.closed && host.get("antigravity-acp") === previous) scope = previous;
      else {
        let predecessor: Promise<void> | undefined;
        try {
          const existing = host.get("antigravity-acp");
          if (existing) predecessor = Promise.resolve(existing.close());
        } catch (error) { predecessor = Promise.reject(error); }
        scope = this.newScope(predecessor);
        this.scopes.set(host, scope); host.set("antigravity-acp", scope);
      }
    }
    let ticket = scope.sessions.get(id);
    if (!ticket || ticket.closed) {
      ticket = { id, closed: false, users: 0, scope };
      scope.sessions.set(id, ticket);
      let entries = this.tickets.get(id);
      if (!entries) this.tickets.set(id, entries = new Set());
      entries.add(ticket);
    }
    ticket.users++;
    return ticket;
  }

  async ready(ticket: Ticket) {
    await ticket.scope.predecessor;
    while (this.closing.has(ticket.id)) await this.closing.get(ticket.id);
    if (ticket.closed) throw new Error("OMP provider session closed before ACP dispatch; retry in the current session");
  }

  attach(ticket: Ticket, bundle: object) {
    if (ticket.closed) throw new Error("OMP provider session closed before ACP dispatch");
    ticket.bundle = bundle;
    // Keep only the routing ID after idle eviction, so a later explicit final
    // release can retire its saved mapping without retaining the runtime.
    ticket.scope.retainedIds.add(ticket.id);
    let entries = this.bundles.get(bundle);
    if (!entries) this.bundles.set(bundle, entries = new Set());
    entries.add(ticket);
  }

  finish(ticket: Ticket) {
    ticket.users--;
    if (!ticket.users && !ticket.bundle) this.forget(ticket);
  }

  private forget(ticket: Ticket) {
    if (ticket.scope.sessions.get(ticket.id) === ticket) ticket.scope.sessions.delete(ticket.id);
    const entries = this.tickets.get(ticket.id);
    entries?.delete(ticket);
    if (!entries?.size) this.tickets.delete(ticket.id);
    if (ticket.bundle) this.bundles.get(ticket.bundle)?.delete(ticket);
    ticket.bundle = undefined;
  }

  disposeRuntime(id: RoutingId, bundle: object, dispose: () => Promise<void>): Promise<void> {
    // Idle eviction may race a still-preparing next request. Preserve its
    // guard so it can restore after teardown; host closeSession() explicitly
    // closes guards first and therefore still cancels stale deferred work.
    for (const ticket of [...this.bundles.get(bundle) ?? []]) {
      ticket.bundle = undefined;
      if (ticket.closed || !ticket.users) this.forget(ticket);
    }
    this.bundles.delete(bundle);
    const pending = Promise.all([this.closing.get(id), dispose()]).then(() => {});
    this.closing.set(id, pending);
    void pending.finally(() => { if (this.closing.get(id) === pending) this.closing.delete(id); }).catch(() => {});
    return pending;
  }

  closeSession(id: RoutingId, released = false): Promise<void> {
    for (const ticket of [...this.tickets.get(id) ?? []]) { ticket.closed = true; ticket.scope.retainedIds.delete(id); this.forget(ticket); }
    const previous = this.closing.get(id), closed = this.closeRuntime(id), teardown = this.closing.get(id);
    const pending = Promise.all([previous, closed, teardown]).then(async () => {
      if (released) await this.releaseRuntime(id);
    });
    // Reusing an ID must also wait for removal of its prior one-shot mapping.
    this.closing.set(id, pending);
    void pending.finally(() => { if (this.closing.get(id) === pending) this.closing.delete(id); }).catch(() => {});
    return pending;
  }

  async waitClosing() {
    while (this.closing.size) await Promise.allSettled(this.closing.values());
  }

  async closeAll() {
    await Promise.allSettled([...this.tickets.keys()].map(id => this.closeSession(id)));
    await this.waitClosing();
  }
}
