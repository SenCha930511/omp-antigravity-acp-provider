// Explicit, isolated live verification of automatic runtime-source selection:
// AGY_ACP_BIN is cleared and PATH carries the real agy CLI, so the adapter
// must select it on its own and the ACP session must advertise the CLI-only
// models. Creates one session, sends no prompt, changes no configuration.
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadRuntimeSourcePreference } from "../extension/adapter-config.ts";
if (!process.argv.includes("--live")) throw new Error("Pass --live explicitly; this probe creates an ACP session and may consume quota.");

delete process.env.AGY_ACP_BIN;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = path.join(os.homedir(), ".omp", "agent", "antigravity-acp-provider");

const { selectAcpRuntime } = await import(pathToFileURL(path.join(root, "extension/acp-runtime-source.ts")).href);
const preference = await selectAcpRuntime(stateDir);
const { TierConnection, ensureAntigravityAcpReady } = await import(pathToFileURL(path.join(root, "extension/runtime.mjs")).href);
if (loadRuntimeSourcePreference(stateDir) === "auto") await ensureAntigravityAcpReady();

const report: { preference: unknown; wrapper: string | null; advertisedModels: unknown[] } = {
  preference,
  wrapper: path.join(stateDir, "agy-acp-cli.sh"),
  advertisedModels: [],
};
const connection = new TierConnection({ cwd: process.cwd(), handlers: {
  onUpdate: async () => {},
  onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
} });
await connection.initialize();
let sessionId: string | undefined;
try {
  const session = await connection.newSession(process.cwd());
  sessionId = session.sessionId;
  const selector = (session.configOptions ?? []).find((option) => option.category === "model");
  report.advertisedModels = (selector?.options ?? []).map((option) => option.value ?? option);
  console.log(JSON.stringify(report, null, 2));
} finally {
  try { if (sessionId) await connection.discardSession(sessionId); }
  finally { await connection.close(); }
}
