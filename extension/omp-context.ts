export interface OmpToolDeclaration { name: string; description?: string; parameters?: unknown }

// OMP tools may be live AgentTool wrappers containing the entire session host,
// counters, executable closures and cycles. ACP bridges declarations only;
// tool execution still returns through OMP's own tool loop.
export function toolDeclarations(tools: readonly OmpToolDeclaration[]): OmpToolDeclaration[] {
  return tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
}

export function normalizeOmpSystemDeltas(messages: unknown[]): unknown[] {
  return messages.map(message => {
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "system") return message;
    const system = message as { toolsAdded?: OmpToolDeclaration[]; toolsRemoved?: Array<{ name: string }> };
    return { ...message,
      ...(system.toolsAdded ? { toolsAdded: toolDeclarations(system.toolsAdded) } : {}),
      ...(system.toolsRemoved ? { toolsRemoved: system.toolsRemoved.map(tool => ({ name: tool.name })) } : {}),
    };
  });
}
