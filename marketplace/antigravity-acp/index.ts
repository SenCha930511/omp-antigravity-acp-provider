import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureAdapter } from "./provision.ts";

export default async function (omp: unknown) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const entry = await ensureAdapter(path.join(root, ".runtime"));
  const adapter = await import(pathToFileURL(entry).href) as { default: (host: unknown) => Promise<void> | void };
  await adapter.default(omp);
}
