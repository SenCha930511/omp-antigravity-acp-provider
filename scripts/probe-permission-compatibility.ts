import fs from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { McpServer } from "@agentclientprotocol/sdk";
import { PiMcpBridge } from "../extension/runtime/tools/bridge.ts";
import { resolveAntigravityAcpDirectory } from "../extension/runtime/acp/antigravity.ts";
import { selectorValues, sessionModes } from "../extension/runtime/acp/session-state.ts";

if (!process.argv.includes("--live")) {
  throw new Error("Pass --live explicitly; this probe creates ACP sessions but sends no model prompt.");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = os.homedir();
const { TierConnection, Type } = await import(pathToFileURL(path.join(root, "extension/runtime.mjs")).href);

function removeConversation(sessionId: string) {
  if (!/^[0-9a-f-]{36}$/iu.test(sessionId)) return;
  for (const suffix of [".db", ".db-shm", ".db-wal", ".meta"]) {
    fs.rmSync(path.join(resolveAntigravityAcpDirectory(), "conversations", sessionId + suffix), { force: true });
  }
}

interface Variant {
  channel: "cli" | "managed";
  command: string;
  args: string[];
  dangerouslySkipPermissions: boolean;
}

const variants: Variant[] = [
  {
    channel: "cli",
    command: process.env.AGY_ACP_CLI ?? "agy",
    args: ["acp", "--app_data_dir=antigravity-acp"],
    dangerouslySkipPermissions: false,
  },
  {
    channel: "cli",
    command: process.env.AGY_ACP_CLI ?? "agy",
    args: ["acp", "--app_data_dir=antigravity-acp", "--dangerously-skip-permissions"],
    dangerouslySkipPermissions: true,
  },
  {
    channel: "managed",
    command: path.join(home, ".local", "opt", "agy-acp", "current", "agy_acp_server.par"),
    args: [],
    dangerouslySkipPermissions: false,
  },
];

async function observeMcp(descriptor: McpServer) {
  if (descriptor.type !== "http") throw new Error("The probe requires an HTTP MCP descriptor");
  const target = new URL(descriptor.url);
  const methods: string[] = [];
  const proxy: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks);
      if (body.length === 0) methods.push(incoming.method ?? "empty-request");
      else {
        try {
          const parsed = JSON.parse(body.toString("utf8")) as { method?: unknown };
          if (typeof parsed.method === "string") methods.push(parsed.method);
        } catch {
          methods.push("invalid-json");
        }
      }
      const forwarded = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: incoming.method,
        headers: { ...incoming.headers, "content-length": body.length },
      }, response => {
        outgoing.writeHead(response.statusCode ?? 500, response.headers);
        response.pipe(outgoing);
      });
      forwarded.on("error", () => outgoing.writeHead(502).end());
      forwarded.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("MCP probe proxy did not bind");
  return {
    methods,
    descriptor: { ...descriptor, url: `http://127.0.0.1:${address.port}/mcp` },
    close: () => new Promise<void>(resolve => proxy.close(() => resolve())),
  };
}

for (const variant of variants) {
  const connection = new TierConnection({
    cwd: process.cwd(),
    command: variant.command,
    args: variant.args,
    handlers: {
      onUpdate: async () => {},
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    },
  });
  const bridge = new PiMcpBridge({
    tools: [{ name: "read", description: "Read a synthetic probe value.", parameters: Type.Object({ path: Type.String() }) }],
    onCall: async () => ({ content: [{ type: "text", text: "unused" }] }),
  });
  const descriptor = await bridge.start();
  if (!descriptor) throw new Error("MCP probe bridge returned no descriptor");
  const mcp = await observeMcp(descriptor);
  let sessionId: string | undefined;
  try {
    const initialized = await connection.initialize();
    const session = await connection.newSession(process.cwd(), undefined, [mcp.descriptor]);
    sessionId = session.sessionId;
    const advertised = sessionModes(session);
    const transitions: Array<{ requested: string; confirmed: string | undefined }> = [];
    for (const mode of advertised?.availableModes ?? []) {
      await connection.setMode(sessionId, mode.id);
      transitions.push({ requested: mode.id, confirmed: sessionModes(connection.getSessionState(sessionId))?.currentModeId });
    }
    if (advertised?.currentModeId) await connection.setMode(sessionId, advertised.currentModeId);
    console.log(JSON.stringify({
      channel: variant.channel,
      dangerouslySkipPermissions: variant.dangerouslySkipPermissions,
      agentInfo: initialized.agentInfo,
      protocolVersion: initialized.protocolVersion,
      agentCapabilities: initialized.agentCapabilities,
      modes: advertised,
      mcpRequests: mcp.methods,
      transitions,
      configOptions: session.configOptions?.map(option => ({
        id: option.id,
        category: option.category,
        type: option.type,
        currentValue: option.currentValue,
        options: option.type === "select" ? selectorValues(option).map(item => item.value) : undefined,
      })),
    }, null, 2));
  } finally {
    try {
      if (sessionId) await connection.discardSession(sessionId);
    } finally {
      await connection.close();
      await Promise.allSettled([mcp.close(), bridge.close()]);
      if (sessionId) removeConversation(sessionId);
    }
  }
}
