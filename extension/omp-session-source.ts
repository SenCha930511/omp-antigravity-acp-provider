import fs from "node:fs/promises";
import path from "node:path";

export interface OmpSessionSource {
  id: string;
  file: string;
  root: string;
  device: number;
  inode: number;
  missingSince?: number;
}

export async function sourceRoot(root: string) {
  if (await fs.realpath(root) !== path.resolve(root)) throw new Error("Unsafe OMP session root");
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error("Invalid OMP session root");
  return stat;
}

// Read only a bounded prefix, never a full transcript. OMP can put a title
// slot before the session header. No header means insufficient deletion proof.
export async function sourceId(file: string): Promise<string> {
  if (await fs.realpath(file) !== path.resolve(file)) throw new Error("Symlinked OMP session");
  const handle = await fs.open(file, "r");
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Invalid OMP session file");
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.toString("utf8", 0, bytesRead).split("\n").slice(0, 4)) {
      try {
        const header = JSON.parse(line);
        if (header.type === "session" && typeof header.id === "string") return header.id;
      } catch { /* A partial line cannot prove identity. */ }
    }
    throw new Error("OMP session header unavailable");
  } finally { await handle.close(); }
}

export interface OmpSourceScan {
  sources: Map<string, string>;
  // False when some journal header could not be read. Absence then proves
  // nothing: the missing session may live in a file this scan could not parse.
  complete: boolean;
}

// Missing files may have moved between workspace buckets. Search only the
// known managed root, with bounded work and no symlinks; any ambiguity preserves
// the ACP session. Called only after a tracked file disappears.
export async function findSources(root: string): Promise<OmpSourceScan> {
  let entries = 0, complete = true;
  const sources = new Map<string, string>();
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > 4) throw new Error("OMP source scan depth exceeded");
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      if (++entries > 20000) throw new Error("OMP source scan limit exceeded");
      if (item.isSymbolicLink()) throw new Error("Ambiguous symlink in OMP session root");
      const file = path.join(dir, item.name);
      if (item.isDirectory()) {
        // Only journal buckets, not the adjacent per-session artifact trees.
        if (/^\d{4}-\d\d-\d\d.*_[\da-f-]+$/i.test(item.name)) continue;
        await visit(file, depth + 1);
      } else if (item.isFile() && item.name.endsWith(".jsonl")) {
        // A crashed writer can leave an empty or truncated journal. That file
        // proves nothing about its own session, but it must not blind the scan
        // for every other one, so it only marks the scan incomplete.
        try { sources.set(await sourceId(file), file); }
        catch { complete = false; }
      }
    }
  }
  await visit(root, 0);
  return { sources, complete };
}
