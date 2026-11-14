import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Portable assets ship at extension/assets/**. This module runs from the
// prebuilt bundle (extension/runtime.mjs), from source (extension/runtime/**)
// and from a test bundle that re-roots the sources, so resolve the asset by
// walking up to the first directory that actually carries it.
const MAX_DEPTH = 8;

export function runtimeAssetPath(relative: string): string {
  const start = path.dirname(fileURLToPath(import.meta.url));
  let directory = start;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    for (const candidate of [path.join(directory, "assets", relative), path.join(directory, "extension", "assets", relative)]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  // Report the bundle-relative location so a missing asset names a real path.
  return path.join(start, "assets", relative);
}
