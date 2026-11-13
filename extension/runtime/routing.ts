// OMP routing identity. A side request (`/btw`, ephemeral one-shot) carries a
// unique routing id such as `MAIN:side:conversation:btw:NONCE:0` plus the
// owning main routing id in `options.parentSessionId`. Only an explicit
// `:side:` segment is a side request: `:spec:` planning ids and forks stay
// ordinary main routes with their own runtime.
export type SessionRoute =
  | { kind: "main"; routingId: string }
  | { kind: "shadow"; routingId: string; parentRoutingId: string };

const SIDE_MARKER = ":side:";

// Strict fallback parser: exactly one leading owner segment, a non-empty side
// remainder, and no nested marker. Anything else is not a side routing id.
export function sideParentRoutingId(routingId: string | undefined): string | undefined {
  if (!routingId) return undefined;
  const at = routingId.indexOf(SIDE_MARKER);
  if (at <= 0 || at + SIDE_MARKER.length >= routingId.length) return undefined;
  if (routingId.includes(SIDE_MARKER, at + 1)) return undefined;
  return routingId.slice(0, at);
}

// The main owner of a routing identity: the parent for a side request, the id
// itself otherwise.
export function ownerRoutingId(routingId: string | undefined): string | undefined {
  return sideParentRoutingId(routingId) ?? routingId;
}

// `options.parentSessionId` is the authoritative owner when OMP provides it;
// the `:side:` parser is the fallback for hosts that only send a routing id.
export function resolveSessionRoute(
  sessionId: string | undefined,
  parentSessionId?: string,
): SessionRoute {
  const routingId = sessionId ?? "";
  const parsedParent = sideParentRoutingId(routingId);
  if (!parsedParent) return { kind: "main", routingId };
  const declared = typeof parentSessionId === "string" ? parentSessionId.trim() : "";
  const parent = declared && declared !== routingId ? ownerRoutingId(declared) : undefined;
  return { kind: "shadow", routingId, parentRoutingId: parent ?? parsedParent };
}

// Pool and lifecycle key for a routing identity. A side request shares its
// parent's runtime entry, so a new one-shot id never spawns a new process.
export function sessionOwnerId(sessionId: string | undefined, parentSessionId?: string): string | undefined {
  const route = resolveSessionRoute(sessionId, parentSessionId);
  return route.kind === "shadow" ? route.parentRoutingId : route.routingId || undefined;
}
