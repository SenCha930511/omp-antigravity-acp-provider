import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  ACP_STEP_TEXT_BYTES,
  buildPromptParts,
  promptTextBytes,
  type PromptParts,
  type TransferContext,
  type TransferMessage,
} from "../extension/context-transfer.ts";

const SAMPLE_COUNT = 7;
const BASELINE_DIGESTS: Readonly<Record<string, string>> = Object.freeze({
  "no-split": "2f896f0f4eb70e6c713446f0b0998a73799a2a781b0fb03d4e6f9f5903602b38",
  "small-history": "32bbdd57b5473dcf2d8fe7b5a57a4115273fd736c9e2b65c62b389c378cff855",
  "many-records": "871e397063693d306ef0c91e1c1bcbac4b81bc04755119215497feaa1fe5bd07",
  "unicode-images": "c02861cd1f1fcd2277c4069b7497757bc0d88b5d9717fd94e24adfc112b957e9",
  "many-attachments": "94d4e57a9fb0fb24c48a26621f397c4b8635015c36921d8ac498456256545df9",
  "split-request": "438fba3cddb8a163c108f0c61799b79dbaec78cf91499dc429f78c74016e4837",
  warm: "c63847a27f33a14ea9efb1fc28019449c91d6f6701c27c4af8b4b154e0beae44",
});

interface BenchmarkResult {
  bytes: number;
  seedSteps: number;
  medianMs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  digest: string;
  samplesMs: number[];
}

function history(count: number, chars: number, imageEvery = 0): TransferContext {
  const messages: TransferMessage[] = Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: [{
      type: "text",
      text: `${index}:中文𠮷\n` + "serialized history ".repeat(chars / 20 - 2) + String(index).padStart(8, "0"),
    }],
  }));
  if (imageEvery > 0) {
    for (let index = imageEvery; index < messages.length; index += imageEvery) {
      const message = messages[index];
      assert.ok(message);
      assert.ok(Array.isArray(message.content));
      message.content.push({ type: "image", data: "aGk=", mimeType: "image/png" });
    }
  }
  messages.push({ role: "user", content: "Current question" });
  return { systemPrompt: "Stable policy\n".repeat(20), messages };
}

function splitRequest(): TransferContext {
  return { messages: [{ role: "user", content: "Large request\n".repeat(40_000) }] };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertBaselineAndStepLimits(name: string, actual: PromptParts): void {
  assert.equal(digest(actual), BASELINE_DIGESTS[name], `${name} differs from its fixed baseline digest`);
  for (const step of [...(actual.seedSteps ?? []), actual.prompt]) {
    assert.ok(
      promptTextBytes(step) <= ACP_STEP_TEXT_BYTES,
      `${name} exceeds the ACP single-step text budget`,
    );
  }
}

const results: Record<string, BenchmarkResult> = {};
for (const [name, context] of [
  ["no-split", history(8, 1000)],
  ["small-history", history(90, 2000)],
  ["many-records", history(500, 2000)],
  ["unicode-images", history(160, 5000, 12)],
  ["many-attachments", history(240, 1600, 1)],
  ["split-request", splitRequest()],
  ["warm", history(100, 3000)],
] as const) {
  const fresh = name !== "warm";
  const unseenStart = fresh ? undefined : context.messages.length + 1;
  const limits = { contextWindow: 1_000_000, policy: { maxTransferBytes: 134_217_728 } };
  if (name === "warm") {
    buildPromptParts(context, true, undefined, limits);
    context.messages.push(
      { role: "assistant", content: "reply" },
      { role: "user", content: "Follow up" },
    );
  }

  const expected = buildPromptParts(context, fresh, unseenStart, limits);
  assertBaselineAndStepLimits(name, expected);
  const expectedDigest = digest(expected);
  const milliseconds: number[] = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
    if (globalThis.gc) globalThis.gc();
    const start = performance.now();
    const actual = buildPromptParts(context, fresh, unseenStart, limits);
    milliseconds.push(performance.now() - start);
    assertBaselineAndStepLimits(name, actual);
    assert.equal(digest(actual), expectedDigest, `${name} changed between benchmark samples`);
  }

  const sorted = [...milliseconds].sort((a, b) => a - b);
  results[name] = {
    bytes: Buffer.byteLength(JSON.stringify(expected)),
    seedSteps: expected.seedSteps?.length ?? 0,
    medianMs: +sorted[Math.floor(SAMPLE_COUNT / 2)]!.toFixed(3),
    meanMs: +(milliseconds.reduce((sum, value) => sum + value, 0) / SAMPLE_COUNT).toFixed(3),
    minMs: +Math.min(...milliseconds).toFixed(3),
    maxMs: +Math.max(...milliseconds).toFixed(3),
    digest: expectedDigest,
    samplesMs: milliseconds.map(value => +value.toFixed(3)),
  };
}

const output = JSON.stringify({ node: process.version, results }, null, 2) + "\n";
const outputPath = process.argv[2];
if (outputPath !== undefined) await writeFile(outputPath, output);
process.stdout.write(output);
