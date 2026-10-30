// Offline comparison against a Git revision. Reads source with git show and
// transpiles it in memory; never starts ACP or reads account/session data.
// node --expose-gc scripts/benchmark-resource-management.ts [BASE_REVISION]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transformSync } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const worker = process.argv[2] === "--worker";
const revision = (worker ? process.argv[4] : process.argv[2]) ?? "HEAD";

async function load(file: string, baseline: boolean) {
  const source = baseline ? execFileSync("git", ["show", `${revision}:${file}`], { cwd: root, encoding: "utf8" })
    : await readFile(path.join(root, file), "utf8");
  const { code } = transformSync(source, { loader: "ts", format: "esm", target: "node22" });
  const resolved = code.replace(/from ["']([^"']+)["']/g, (match, specifier) => {
    if (specifier.startsWith(".")) return `from ${JSON.stringify(pathToFileURL(path.resolve(root, path.dirname(file), specifier)).href)}`;
    if (!specifier.startsWith("node:")) return `from ${JSON.stringify(import.meta.resolve(specifier))}`;
    return match;
  });
  return import(`data:text/javascript;base64,${Buffer.from(resolved).toString("base64")}`);
}

const user = (content: any) => ({ role: "user", content });
function validCases() {
  const cases: Array<[any, boolean, number | undefined]> = [];
  for (let i = 0; i < 64; i++) {
    const text = ('中文\\quoted"\n𠮷 '.repeat(i + 1));
    const image = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
    const messages = [
      { role: "system", content: `RULES ${i}` },
      user(i % 2 ? text : [{ type: "text", text }, image]),
      { role: "assistant", provider: "antigravity-acp", model: "synthetic", content: [{ type: "text", text: "DONE" }] },
      user([{ type: "text", text: `NEW ${text}` }, ...(i % 3 ? [] : [image])]),
    ];
    const context = { systemPrompt: "FALLBACK_RULES", messages };
    cases.push([context, true, undefined], [context, false, 3]);
    const continuing = { ...context, messages: [...messages,
      { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "fixture" } }] },
      { role: "toolResult", toolName: "read", toolCallId: "call", isError: i % 2 === 0,
        content: [{ type: "text", text: "RESULT" }, ...(i % 4 ? [] : [image])] },
    ] };
    cases.push([continuing, true, undefined], [continuing, false, 5]);
  }
  return cases;
}

const limits = { contextWindow: 1_000_000 };
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function measure(work: () => void, iterations: number) {
  const gc = (globalThis as any).gc as (() => void) | undefined;
  if (!gc) throw new Error("Run with --expose-gc");
  for (let i = 0; i < 5; i++) work();
  const wall: number[] = [], cpu: number[] = [], heap: number[] = [];
  for (let sample = 0; sample < 9; sample++) {
    gc();
    const before = process.memoryUsage().heapUsed, started = performance.now(), usage = process.cpuUsage();
    for (let i = 0; i < iterations; i++) work();
    const elapsed = process.cpuUsage(usage);
    wall.push((performance.now() - started) / iterations);
    cpu.push((elapsed.user + elapsed.system) / 1000 / iterations);
    heap.push(process.memoryUsage().heapUsed - before);
  }
  return { medianWallMsPerCall: median(wall), medianCpuMsPerCall: median(cpu),
    maxObservedHeapDeltaBytes: Math.max(...heap), iterationsPerSample: iterations, samples: wall.length };
}

if (worker) {
  const baseline = process.argv[3] === "baseline";
  const { buildPromptParts } = await load("extension/context-transfer.ts", baseline);
  const normal = validCases().at(-2)!;
  const oversized = { messages: [user("x".repeat(32 * 1024 * 1024)), user("LATEST")] };
  // Flatten the fixture before measuring, independently of serializer work.
  Buffer.byteLength(oversized.messages[0].content);
  const normalTransfer = measure(() => { buildPromptParts(...normal, limits); }, 100);
  const oversizedTransfer = measure(() => {
    assert.throws(() => buildPromptParts(oversized, true, undefined, limits), /Maximum context length exceeded|413/);
  }, 1);
  const { SessionRuntimePool } = await load("extension/runtime-pool.ts", baseline);
  let runtimeCreations = 0;
  const pool = new SessionRuntimePool(() => ({ id: ++runtimeCreations }), async () => {}, { timeoutMs: 0, maxIdleEntries: 2 });
  pool.get("main-a"); pool.get("main-b");
  for (let i = 0; i < 100; i++) {
    const lease = pool.acquire("temporary");
    await pool.close("temporary"); lease.release();
    pool.get("main-a"); pool.get("main-b");
  }
  await pool.closeAll();
  const { CatalogStore } = await load("extension/catalog-store.ts", baseline);
  let fallbackProjections = 0;
  const store = new CatalogStore(path.join(os.tmpdir(), `omp-resource-bench-missing-${process.pid}`, "cache.json"), {}, async () => {}, () => {
    fallbackProjections++;
    return [{ id: "synthetic", contextWindow: 32768, maxTokens: 8192 }];
  });
  const settings = { defaults: {}, models: {} };
  for (let i = 0; i < 100; i++) store.getDynamicModels(settings);
  console.log(JSON.stringify({ normalTransfer, oversizedTransfer, runtimeCreations, fallbackProjections }));
} else {
  const before = await load("extension/context-transfer.ts", true);
  const after = await load("extension/context-transfer.ts", false);
  const cases = validCases();
  for (const input of cases) assert.deepEqual(after.buildPromptParts(...input, limits), before.buildPromptParts(...input, limits));
  const results: Record<string, unknown> = {};
  for (const kind of ["baseline", "candidate"]) {
    results[kind] = JSON.parse(execFileSync(process.execPath,
      ["--expose-gc", fileURLToPath(import.meta.url), "--worker", kind, revision],
      { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 }));
  }
  console.log(JSON.stringify({ baselineRevision: revision, node: process.version, platform: `${os.platform()} ${os.arch()}`,
    equivalentPromptCases: cases.length, ...results }, null, 2));
}
