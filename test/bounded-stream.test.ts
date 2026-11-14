import assert from "node:assert/strict";
import test from "node:test";

import { boundedNdjsonStream } from "../extension/runtime/acp/bounded-stream.ts";

test("the NDJSON reader does not drain the child stream ahead of the consumer", async () => {
  const encoder = new TextEncoder();
  let pulls = 0;
  const input = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls > 100) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", method: "frame" })}\n`));
    },
  });
  const stream = boundedNdjsonStream(new WritableStream(), input);
  const reader = stream.readable.getReader();
  try {
    const first = await reader.read();
    assert.equal(first.done, false);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(pulls <= 3, `the reader pulled ${pulls} chunks before the consumer asked for more`);
  } finally {
    await reader.cancel();
  }
});

test("splits multiple frames in one chunk and joins a frame split across chunks", async () => {
  const encoder = new TextEncoder();
  const first = JSON.stringify({ jsonrpc: "2.0", method: "first" });
  const second = JSON.stringify({ jsonrpc: "2.0", method: "second" });
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${first}\n${second.slice(0, 5)}`));
      controller.enqueue(encoder.encode(`${second.slice(5)}\n`));
      controller.close();
    },
  });
  const stream = boundedNdjsonStream(new WritableStream(), input);
  const reader = stream.readable.getReader();
  try {
    const messages = [];
    for (let index = 0; index < 2; index++) {
      const next = await reader.read();
      assert.equal(next.done, false);
      messages.push(next.value);
    }
    assert.deepEqual(messages.map(message => message.method), ["first", "second"]);
    assert.equal((await reader.read()).done, true);
  } finally {
    await reader.cancel();
  }
});

test("cancelling the readable cancels the underlying reader", async () => {
  let cancelled = false;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", method: "frame" })}\n`));
    },
    cancel() { cancelled = true; },
  });
  const stream = boundedNdjsonStream(new WritableStream(), input);
  await stream.readable.cancel("stop");
  assert.equal(cancelled, true);
});

test("consumes a large coalesced frame chunk with a linear queue cursor", async () => {
  const count = 4096;
  const payload = `${Array.from({ length: count }, (_, index) =>
    JSON.stringify({ jsonrpc: "2.0", method: `frame-${index}` })).join("\n")}\n`;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  const stream = boundedNdjsonStream(new WritableStream(), input);
  const reader = stream.readable.getReader();
  try {
    for (let index = 0; index < count; index++) {
      const next = await reader.read();
      assert.equal(next.done, false);
      assert.equal(next.value.method, `frame-${index}`);
    }
    assert.equal((await reader.read()).done, true);
  } finally {
    await reader.cancel();
  }
});
