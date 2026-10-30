import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRuntimePool } from "../extension/runtime-pool.ts";

test("idle eviction waits for leases and outstanding ACP work, then closes exactly once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let busy = true;
  const disposed: number[] = [];
  let serial = 0;
  const pool = new SessionRuntimePool(() => ({ id: ++serial }), async e => { disposed.push(e.id); },
    { timeoutMs: 1000, canDispose: () => !busy });
  const lease = pool.acquire("main");
  t.mock.timers.tick(5000);
  assert.deepEqual(disposed, []);
  lease.release(); lease.release();
  t.mock.timers.tick(1000);
  assert.deepEqual(disposed, []);
  busy = false;
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.deepEqual(disposed, [lease.value.id]);
  assert.notEqual(pool.get("main"), lease.value);
  await pool.closeAll();
});

function fixture() {
  let created = 0;
  const disposed: number[] = [];
  const pool = new SessionRuntimePool(
    () => ({ id: ++created }),
    async entry => { disposed.push(entry.id); },
  );
  return { pool, disposed, count: () => created };
}

test("construction and inspection are lazy", () => {
  const { pool, count } = fixture();
  assert.deepEqual(pool.values(), []);
  assert.equal(count(), 0);
});

test("planning shutdown leaves the main runtime usable", async () => {
  const { pool, disposed } = fixture();
  const main = pool.get("main");
  const plan = pool.get("plan");
  await pool.close("plan");
  assert.equal(pool.get("main"), main);
  assert.deepEqual(disposed, [plan.id]);
  assert.notEqual(pool.get("plan"), plan);
});

test("refining a disposed session creates a fresh runtime", async () => {
  const { pool, disposed } = fixture();
  const first = pool.get("session");
  await pool.close("session");
  const next = pool.get("session");
  assert.notEqual(next, first);
  await pool.closeAll();
  assert.deepEqual(disposed, [first.id, next.id]);
});

test("detach happens before asynchronous teardown completes", async () => {
  let release!: () => void;
  let serial = 0;
  const pool = new SessionRuntimePool(
    () => ({ id: ++serial }),
    () => new Promise<void>(resolve => { release = resolve; }),
  );
  const previous = pool.get("same");
  const closing = pool.close("same");
  assert.notEqual(pool.get("same"), previous);
  release();
  await closing;
});

test("repeated close never creates or disposes extra resources", async () => {
  const { pool, disposed, count } = fixture();
  pool.get("session");
  await pool.close("session");
  await pool.close("session");
  await pool.closeAll();
  assert.equal(count(), 1);
  assert.deepEqual(disposed, [1]);
});

test("global shutdown clears all ownership even when disposal rejects", async () => {
  const pool = new SessionRuntimePool(() => ({}), async () => { throw Error("shutdown"); });
  pool.get("main");
  pool.get("plan");
  await pool.closeAll();
  assert.deepEqual(pool.values(), []);
});

test("closeIdle closes idle runtime but preserves leased or busy entry", async () => {
  let busy = true;
  const disposed: number[] = [];
  let serial = 0;
  const pool = new SessionRuntimePool(() => ({ id: ++serial }), async e => { disposed.push(e.id); },
    { canDispose: () => !busy });

  // 1. leased entry
  const leased = pool.acquire();
  assert.equal(await pool.closeIdle(), false);
  assert.deepEqual(disposed, []);
  leased.release();

  // 2. busy entry
  assert.equal(await pool.closeIdle(), false);
  assert.deepEqual(disposed, []);

  // 3. idle entry
  busy = false;
  assert.equal(await pool.closeIdle(), true);
  assert.deepEqual(disposed, [leased.value.id]);

  // 4. missing entry
  assert.equal(await pool.closeIdle("non-existent"), false);
});

test("acquiring active work does not spend an idle slot or evict a reusable runtime", async () => {
  let serial = 0;
  const closed: number[] = [];
  const pool = new SessionRuntimePool(() => ({ id: ++serial }), async entry => { closed.push(entry.id); },
    { timeoutMs: 0, maxIdleEntries: 1 });
  const idle = pool.get("idle");
  const active = pool.acquire("active");
  assert.equal(pool.peek("idle"), idle);
  assert.deepEqual(closed, []);
  active.release();
  assert.deepEqual(closed, [idle.id]);
  await pool.closeAll();
});

test("concurrent global shutdowns both wait for teardown", async () => {
  const gate = Promise.withResolvers<void>();
  const pool = new SessionRuntimePool(() => ({}), () => gate.promise);
  pool.get("entry");
  const first = pool.closeAll();
  let done = false;
  const second = pool.closeAll().then(() => { done = true; });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(done, false);
  gate.resolve();
  await Promise.all([first, second]);
});
