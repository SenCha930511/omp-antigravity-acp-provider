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
