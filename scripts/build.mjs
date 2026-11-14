import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, "extension/runtime");
const assets = path.join(root, "extension/assets");

// The portable assets are ordinary owned sources next to the runtime. The
// build only publishes them where the marketplace launcher expects them.
await fs.mkdir(path.join(assets, "src/acp"), { recursive: true });
await fs.copyFile(path.join(runtime, "supervisor.mjs"), path.join(assets, "src/acp/supervisor.mjs"));
await fs.copyFile(path.join(runtime, "runtime-manifest.json"), path.join(assets, "runtime-manifest.json"));

const result = await build({
  entryPoints: [path.join(runtime, "index.ts")],
  bundle: true,
  metafile: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Bundled CJS dependencies need require in ESM.
  banner: { js: [
    'import { createRequire as __ompCreateRequire } from "node:module";',
    'const require = __ompCreateRequire(import.meta.url);',
  ].join("\n") },
  external: ["@aws-sdk/client-s3"],
  outfile: path.join(root, "extension/runtime.mjs"),
  logLevel: "info",
});

// The npm tarball ships a bundle. Include the full notices of packages whose
// code is bundled, in addition to their individually installed npm licenses.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes("node_modules")) continue;
  let directory = path.dirname(path.resolve(root, input));
  while (directory !== path.dirname(directory)) {
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
      if (metadata.name && metadata.version) {
        packages.set(directory, metadata);
        break;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    directory = path.dirname(directory);
  }
}
const notices = [];
for (const [directory, metadata] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  const names = (await fs.readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(name));
  const texts = [];
  for (const name of names) {
    if ((await fs.stat(path.join(directory, name))).isFile()) {
      texts.push(`${name}\n${await fs.readFile(path.join(directory, name), "utf8")}`);
    }
  }
  if (!texts.length && metadata.name === "@earendil-works/pi-ai" && metadata.version === "1.3.0") {
    texts.push(await fs.readFile(path.join(root, "licenses/pi-ai-1.3.0.txt"), "utf8"));
  }
  if (!texts.length) {
    for (const name of (await fs.readdir(directory)).filter(name => /^readme(?:\..*)?$/i.test(name))) {
      const readme = await fs.readFile(path.join(directory, name), "utf8");
      const license = readme.match(/^#{1,6}\s+License\s*\r?\n([\s\S]*)/im)?.[1];
      if (license?.includes("Copyright") && license.includes("Permission is hereby granted")) {
        texts.push(`${name} license section\n${license}`);
      }
    }
  }
  if (!texts.length) throw new Error(`Missing bundled license notice for ${metadata.name}`);
  notices.push(`${metadata.name}@${metadata.version}\nLicense: ${metadata.license ?? "see notice"}\n\n${texts.join("\n\n")}`);
}
await fs.writeFile(path.join(root, "THIRD_PARTY_LICENSES.txt"), notices.join("\n\n============================================================\n\n") + "\n");
