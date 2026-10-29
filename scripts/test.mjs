import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Compiled output must live inside the project so runtime resolution of the
// externalized node_modules dependencies walks up to the project root.
const output = path.join(root, ".test-build");
// The vendored upstream ships TypeScript sources under extension/vendor, which Node
// refuses to type-strip at runtime; those imports stay bundled while every
// other package loads directly from the project's node_modules.
const upstream = path.join(root, "extension/vendor/pi-antigravity-acp-provider");
try {
  const entries = (await readdir(path.join(root, "test")))
    .filter(file => file.endsWith(".test.ts"))
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
    plugins: [{
      name: "bundle-upstream-typescript",
      setup(builder) {
        builder.onResolve({ filter: /^pi-antigravity-acp-provider(\/|$)/ }, args => {
          const suffix = args.path.slice("pi-antigravity-acp-provider".length);
          return { path: path.join(upstream, suffix) };
        });
      },
    }],
    logLevel: "warning",
  });
  const compiled = (await readdir(path.join(output, "test")))
    .filter(file => file.endsWith(".mjs"))
    .map(file => path.join(output, "test", file));
  const result = spawnSync(process.execPath, ["--test", ...compiled], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(output, { recursive: true, force: true });
}
