import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
if (!process.argv.includes("--live")) throw new Error("Pass --live; real Flash generation/summary with a synthetic context trigger.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auto-compact-live-"));
const profile = `acp-compact-${Date.now()}`;
const profilePath = path.join(os.homedir(), ".omp/profiles", profile);
try {
  await fs.mkdir(profilePath, { recursive: true });
  await fs.copyFile(path.join(os.homedir(), ".omp/agent/antigravity-acp-provider/models-cache.json"), path.join(temporary, "models-cache.json"));
  await fs.copyFile(path.join(os.homedir(), ".omp/agent/antigravity-acp-provider/omp-tools.json"), path.join(temporary, "omp-tools.json"));
  const operation = promisify(execFile)("omp", [
    "--profile", profile, "--no-extensions", "-e", path.join(root, "test/fixtures/auto-compaction-extension.ts"),
    "--config", path.join(root, "test/fixtures/auto-compaction-config.json"),
    "--model", "antigravity-acp-provider/gemini-3.8-flash", "--smol", "antigravity-acp-provider/gemini-3.8-flash",
    "--thinking", "low", "--api-key", "pi-antigravity-acp:managed-by-antigravity",
    "--no-tools", "--no-skills", "--no-rules", "--no-title", "--no-session", "--no-prewalk", "--mode", "json",
    "--system-prompt", "You are a diagnostic assistant. Answer briefly without tools.",
    "-p", "Remember the synthetic project identifier COMPACT_KEEP_73D2. Reply with that identifier only.",
  ], { cwd: temporary, env: { ...process.env, OMP_ACP_COMPACTION_PROBE_STATE: temporary, OMP_ACP_USAGE: "off" }, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  operation.child.stdin?.end();
  const result = await operation;
  const events = result.stdout.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const types = events.map(e => e.type);
  console.log(JSON.stringify({ types, syntheticTrigger: result.stderr.includes("SYNTHETIC_CONTEXT_TRIGGER_50000"),
    compaction: events.filter(e => /compaction/.test(e.type)) }));
  assert.ok(result.stderr.includes("SYNTHETIC_CONTEXT_TRIGGER_50000"));
  assert.ok(types.includes("auto_compaction_start"), "OMP automatic compaction was not started");
  const done = events.find(e => e.type === "auto_compaction_end");
  assert.ok(done && !done.aborted && !done.errorMessage, "OMP compaction did not finish successfully");
  assert.ok(done.result?.summary?.includes("COMPACT_KEEP_73D2"), "Compaction summary lost the fixture identifier");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.rm(profilePath, { recursive: true, force: true });
}
