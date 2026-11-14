import type { SessionNotification } from "@agentclientprotocol/sdk";

export type AcpActivity =
	| { type: "text"; delta: string }
	| { type: "thought"; delta: string }
	| { type: "tool"; text: string }
	| { type: "plan"; text: string }
	| { type: "unknown"; updateType: string };

export function mapSessionUpdate(notification: SessionNotification): AcpActivity[] {
	const update = notification.update;
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
			return update.content.type === "text"
				? [{ type: "text", delta: update.content.text }]
				: [{ type: "unknown", updateType: `agent_message:${update.content.type}` }];
		case "agent_thought_chunk":
			return update.content.type === "text"
				? [{ type: "thought", delta: update.content.text }]
				: [{ type: "unknown", updateType: `agent_thought:${update.content.type}` }];
		case "tool_call": {
			const status = update.status ? ` — ${update.status}` : "";
			return [{ type: "tool", text: `\n[Antigravity tool: ${clean(update.title)}${status}]\n` }];
		}
		case "tool_call_update": {
			const label = update.title ? clean(update.title) : clean(update.toolCallId);
			const status = update.status ? ` — ${update.status}` : "";
			const details = toolContentText(update.content);
			return [
				{
					type: "tool",
					text: `\n[Antigravity tool update: ${label}${status}]${details ? `\n${details}\n` : "\n"}`,
				},
			];
		}
		case "plan": {
			const lines = update.entries.map((entry) => `- [${entry.status}] ${clean(entry.content)}`);
			return lines.length ? [{ type: "plan", text: `\n[Antigravity plan]\n${lines.join("\n")}\n` }] : [];
		}
		default:
			return [{ type: "unknown", updateType: update.sessionUpdate }];
	}
}

function toolContentText(content: SessionNotification["update"] extends infer _T ? unknown : never): string {
	if (!Array.isArray(content)) return "";
	const output: string[] = [];
	for (const item of content.slice(0, 8)) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (record.type === "diff") {
			const path = typeof record.path === "string" ? clean(record.path) : "file";
			output.push(`[diff: ${path}]`);
		} else if (record.type === "content") {
			const block = record.content as Record<string, unknown> | undefined;
			if (block?.type === "text" && typeof block.text === "string") {
				output.push(clean(block.text).slice(0, 2_000));
			}
		}
	}
	return output.join("\n").slice(0, 4_000);
}

function clean(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, 2_000);
}
