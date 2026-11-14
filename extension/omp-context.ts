import type { Message, Tool } from "@earendil-works/pi-ai";

export interface OmpToolDeclaration { name: string; description?: string; parameters?: unknown }

// OMP tools may be live AgentTool wrappers containing the entire session host,
// counters, executable closures and cycles. ACP bridges declarations only;
// tool execution still returns through OMP's own tool loop.
export function toolDeclarations(tools: readonly Tool[]): Tool[];
export function toolDeclarations(tools: readonly OmpToolDeclaration[]): OmpToolDeclaration[];
export function toolDeclarations(tools: readonly OmpToolDeclaration[]): OmpToolDeclaration[] {
  return tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
}

export function normalizeOmpSystemDeltas(messages: Message[]): Message[];
export function normalizeOmpSystemDeltas(messages: unknown[]): unknown[];
export function normalizeOmpSystemDeltas(messages: unknown[]): unknown[] {
  if (!messages.some(message => message && typeof message === "object" && "role" in message && message.role === "system")) {
    return messages;
  }
  return messages.map(message => {
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "system") return message;
    const toolsAdded = "toolsAdded" in message && Array.isArray(message.toolsAdded)
      ? toolDeclarations(message.toolsAdded)
      : undefined;
    const toolsRemoved = "toolsRemoved" in message && Array.isArray(message.toolsRemoved)
      ? message.toolsRemoved.map((tool: { name: string }) => ({ name: tool.name }))
      : undefined;
    return { ...message,
      ...(toolsAdded ? { toolsAdded } : {}),
      ...(toolsRemoved ? { toolsRemoved } : {}),
    };
  });
}
