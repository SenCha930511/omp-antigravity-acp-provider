// OMP supplies tools in its own declaration order. ACP projections, the MCP
// tools/list response and every omission report keep that order; sorting here
// would silently reorder both the bridge and the task-reservation boundary.
export function stableTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return [...tools];
}
