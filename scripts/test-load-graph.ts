// The adapter's omp load-time graph must stay free of bare package imports.
//
// OMP's extension loader resolves bare specifiers unreliably for modules
// reached through the marketplace launcher's dynamic `import(file://…)` of
// the downloaded adapter (observed with `@agentclientprotocol/sdk` on
// OMP 18.12.5). Everything upstream therefore has to arrive pre-bundled in
// extension/runtime.mjs; source files that bare-import packages
// (tier-connection.ts, session-cleanup.ts, usage.ts, …) may only be reached
// through the bundle, never directly from the load-time graph.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const transpiler = new Bun.Transpiler({ loader: "ts" });
const root = path.resolve(import.meta.dir, "..");
const seen = new Set<string>();
const offenders: Array<{ file: string; spec: string }> = [];

function walk(file: string): void {
  const resolved = path.resolve(file);
  if (seen.has(resolved)) return;
  seen.add(resolved);
  const code = fs.readFileSync(resolved, "utf8");
  for (const item of transpiler.scanImports(code)) {
    const spec = item.path;
    if (item.kind === "import-type" || spec.startsWith("node:")) continue;
    if (!spec.startsWith(".") && !path.isAbsolute(spec)) {
      offenders.push({ file: path.relative(root, resolved), spec });
      continue;
    }
    const next = path.resolve(path.dirname(resolved), spec);
    if (next.endsWith(".ts") || next.endsWith(".mjs")) walk(next);
  }
}

walk(path.join(root, "extension/index.ts"));

const files = [...seen].map(file => path.relative(root, file)).sort();
assert.ok(files.includes("extension/runtime.mjs"), "load graph must include the prebuilt bundle");
for (const forbidden of ["extension/tier-connection.ts", "extension/session-cleanup.ts", "extension/usage.ts"]) {
  assert.ok(!files.includes(forbidden), `${forbidden} must only be reached through extension/runtime.mjs`);
}
assert.deepEqual(offenders, [], `bare package imports in the load-time graph are not resolvable by OMP's launcher: ${JSON.stringify(offenders)}`);
console.log(`Load-time graph (${files.length} files) has no bare package imports: PASS`);
