// Explicit, isolated live probe of the model selector Antigravity advertises
// over ACP, and whether non-advertised account models (Claude) are selectable.
// Creates one session, runs at most one tiny prompt, changes no configuration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
if (!process.argv.includes("--live")) throw new Error("Pass --live explicitly; this probe creates an ACP session and may consume quota.");

const wrapper = path.join(os.homedir(), ".omp/plugins/node_modules/omp-antigravity-acp-provider");
const version = JSON.parse(fs.readFileSync(path.join(wrapper, "package.json"), "utf8")).version;
const root = path.join(wrapper, ".runtime", version, "node_modules/omp-antigravity-acp-provider");
const { TierConnection, ensureAntigravityAcpReady } = await import(pathToFileURL(path.join(root, "extension/runtime.mjs")).href);

const report: any = { installedVersion: version, answer: "", rawEvents: {}, setModel: {}, stateAfter: {}, promptResult: null };
await ensureAntigravityAcpReady();
const connection = new TierConnection({ cwd: process.cwd(), handlers: {
  onUpdate: async (notification: any) => {
    const update = notification.update;
    report.rawEvents[update.sessionUpdate] = (report.rawEvents[update.sessionUpdate] ?? 0) + 1;
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") {
      report.answer += update.content.text;
    }
  },
  onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
} });
await connection.initialize();
let sessionId: string | undefined;
try {
  const session = await connection.newSession(process.cwd());
  sessionId = session.sessionId;
  report.advertised = (session.configOptions ?? []).find((option: any) => option.category === "model") ?? null;
  for (const modelId of ["claude-sonnet-5-5", "claude-sonnet-5-5-high", "claude-opus-5-5"]) {
    try {
      await connection.setModel(sessionId, modelId);
      report.setModel[modelId] = "accepted";
      const state: any = connection.getSessionState(sessionId);
      report.stateAfter[modelId] = {
        model: (state.configOptions ?? []).find((option: any) => option.category === "model") ?? null,
        thought: (state.configOptions ?? []).find((option: any) => option.category === "thought_level") ?? null,
      };
      break;
    } catch (error) {
      report.setModel[modelId] = String(error);
    }
  }
  if (Object.values(report.setModel).includes("accepted")) {
    const result = await connection.prompt({ sessionId, prompt: [{ type: "text", text: "Reply with exactly this single word and nothing else: PROBE_OK" }] },
      AbortSignal.timeout(120_000));
    report.promptResult = { stopReason: result?.stopReason ?? null, keys: Object.keys(result ?? {}) };
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  try { if (sessionId) await connection.discardSession(sessionId); }
  finally { await connection.close(); }
}
