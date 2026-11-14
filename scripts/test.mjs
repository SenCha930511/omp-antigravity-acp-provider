import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Compiled output must live inside the project so runtime resolution of the
// externalized node_modules dependencies walks up to the project root.
const output = path.join(root, ".test-build");
// Local TypeScript is bundled (Node cannot type-strip project sources at
// runtime), while every package loads directly from node_modules.
try {
  const filters = process.argv.slice(2);
  const files = (await readdir(path.join(root, "test"))).filter(file => file.endsWith(".test.ts"));
  for (const filter of filters) {
    if (!filter || !files.some(file => file.includes(filter))) {
      throw new Error(`No test files matched: ${filter || "(empty filter)"}`);
    }
  }
  const entries = files
    .filter(file => filters.length === 0 || filters.some(filter => file.includes(filter)))
    .map(file => path.join(root, "test", file));
  await build({
    entryPoints: entries,
    outdir: output,
    outbase: root,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    // External packages resolve from node_modules when the tests run, and
    // code splitting shares the extension sources (and runtime.mjs) between
    // test files instead of re-bundling them into every entry.
    packages: "external",
    splitting: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: "warning",
  });
  const compiled = entries.map(file => path.join(
    output, "test", `${path.basename(file, ".ts")}.mjs`,
  ));
  const result = spawnSync(process.execPath, ["--test", ...compiled], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(output, { recursive: true, force: true });
}
