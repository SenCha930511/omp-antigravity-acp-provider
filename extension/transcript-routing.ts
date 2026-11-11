import type { OmpProviderSessionState } from "./omp-session-lifecycle.ts";

interface Source {
  transcriptId: string;
  file: string;
  epoch?: number;
  attempt?: RoutingAttempt;
}

interface Route {
  id: string;
  owner: OmpProviderSessionState | undefined;
  file?: string;
  attempt?: RoutingAttempt;
}

interface SourceChange {
  owner: OmpProviderSessionState;
  previous: Source | undefined;
  assigned: Source | undefined;
}

interface Claim {
  previous: Route | undefined;
  sourceChanges: SourceChange[];
  attempt: RoutingAttempt;
}

export interface RoutingAttempt {
  readonly id: string;
  readonly owner: OmpProviderSessionState | undefined;
  readonly replacedOwner: OmpProviderSessionState | undefined;
  state: "active" | "succeeded" | "failed";
  readonly claims: Map<string, Claim>;
}

interface Replacement {
  attempt: RoutingAttempt;
  source: Source;
  epoch: number;
}

// Header identity and the SDK's ephemeral provider routing ID can differ after
// /fresh. Provenance uses the exact source file together with lifecycle owner.
const sameSource = (a: Source, b: Source) => a.file === b.file;

// OMP's session events expose a transcript ID, while streamSimple receives the
// provider routing ID. They are usually equal, but /fresh can rotate one without
// the other. A replacement is bound to the exact source established for the
// replaced owner; sharing that owner (as parents and forks do) is not proof.
export class TranscriptRouting {
  private transitionEpoch = 0;
  private readonly byTranscript = new Map<string, Route>();
  private readonly pending = new Map<string, RoutingAttempt>();
  private readonly replacements = new Map<OmpProviderSessionState, Replacement>();
  private readonly replacementsById = new Map<string, Replacement>();
  private readonly currentSources = new Map<OmpProviderSessionState, Source>();

  private removePending(attempt: RoutingAttempt): void {
    if (this.pending.get(attempt.id) === attempt) this.pending.delete(attempt.id);
  }

  private retireReplacement(replacement: Replacement): void {
    const { attempt } = replacement;
    if (this.replacements.get(attempt.replacedOwner!) === replacement) {
      this.replacements.delete(attempt.replacedOwner!);
    }
    if (this.replacementsById.get(attempt.id) === replacement) this.replacementsById.delete(attempt.id);
  }

  private invalidateAttempt(attempt: RoutingAttempt, source?: Source): void {
    // Terminal for routing purposes; provider teardown remains the lifecycle's job.
    attempt.state = "failed";
    this.removePending(attempt);
    const replacement = this.replacementsById.get(attempt.id);
    if (replacement?.attempt === attempt) this.retireReplacement(replacement);
    for (const [transcriptId, route] of this.byTranscript) {
      if (transcriptId === attempt.id || route.attempt !== attempt) continue;
      const claim = attempt.claims.get(transcriptId);
      this.byTranscript.delete(transcriptId);
      for (const change of claim?.sourceChanges ?? []) {
        if (change.assigned && this.currentSources.get(change.owner) === change.assigned) {
          this.currentSources.delete(change.owner);
        }
      }
    }
    const expected = source ?? (attempt.owner ? this.currentSources.get(attempt.owner) : undefined);
    for (const [owner, current] of this.currentSources) {
      if (current === expected || current.attempt === attempt) this.currentSources.delete(owner);
    }
    attempt.claims.clear();
  }

  private claim(transcriptId: string, route: Route, attempt: RoutingAttempt): Claim {
    let claim = attempt.claims.get(transcriptId);
    if (!claim) {
      claim = { previous: this.byTranscript.get(transcriptId), sourceChanges: [], attempt };
      attempt.claims.set(transcriptId, claim);
    }
    route.attempt = attempt;
    this.byTranscript.set(transcriptId, route);
    return claim;
  }

  private changeClaimedSource(
    claim: Claim,
    owner: OmpProviderSessionState | undefined,
    assigned: Source | undefined,
  ): void {
    if (!owner) return;
    const previous = this.currentSources.get(owner);
    // A late parent completion must not move an established owner back from a
    // fork. Explicit noteSourceSwitch is the only different-source advance.
    if (assigned && previous && !sameSource(previous, assigned)) return;
    if (previous === assigned) return;
    const next: Source | undefined = assigned ? {
      ...assigned, attempt: claim.attempt, epoch: assigned.epoch ?? this.transitionEpoch,
    } : undefined;
    claim.sourceChanges.push({ owner, previous, assigned: next });
    if (next) this.currentSources.set(owner, next);
    else this.currentSources.delete(owner);
  }

  noteStream(id: string | undefined, owner?: OmpProviderSessionState, replacedOwner?: OmpProviderSessionState): RoutingAttempt | undefined {
    if (!id || id.includes(":side:")) return undefined;
    const attempt: RoutingAttempt = { id, owner, replacedOwner, state: "active", claims: new Map() };
    const oldReplacement = this.replacementsById.get(id);
    if (oldReplacement) this.retireReplacement(oldReplacement);
    this.pending.set(id, attempt);
    if (!owner || !replacedOwner) return attempt;

    const source = this.currentSources.get(replacedOwner);
    if (!source || source.epoch !== this.transitionEpoch) return attempt;
    const previous = this.replacements.get(replacedOwner);
    if (previous) this.retireReplacement(previous);
    const replacement = { attempt, source, epoch: this.transitionEpoch };
    this.replacements.set(replacedOwner, replacement);
    this.replacementsById.set(id, replacement);
    return attempt;
  }

  // Completion does not remove an unclaimed direct join or replacement: OMP's
  // source event can arrive after the provider stream. Only rollback history is
  // no longer needed once the operation has succeeded.
  noteSuccess(attempt: RoutingAttempt | undefined): void {
    if (!attempt || attempt.state !== "active") return;
    attempt.state = "succeeded";
    attempt.claims.clear();
  }

  noteFailure(attempt: RoutingAttempt | undefined): void {
    if (!attempt || attempt.state !== "active") return;
    attempt.state = "failed";
    this.removePending(attempt);
    const replacement = this.replacementsById.get(attempt.id);
    if (replacement?.attempt === attempt) this.retireReplacement(replacement);

    // Route-token identity prevents a late failure from undoing a newer
    // generation, even with the same ID. Source indexes roll back atomically
    // with the route, and only while each change still has its assigned value.
    for (const [transcriptId, claim] of attempt.claims) {
      if (this.byTranscript.get(transcriptId)?.attempt !== attempt) continue;
      const failedPredecessor = claim.previous?.attempt?.state === "failed";
      if (claim.previous && !failedPredecessor) this.byTranscript.set(transcriptId, claim.previous);
      else this.byTranscript.delete(transcriptId);
      for (const change of [...claim.sourceChanges].reverse()) {
        const current = this.currentSources.get(change.owner);
        const stillAssigned = change.assigned === undefined
          ? current === undefined
          : current === change.assigned;
        if (!stillAssigned) continue;
        if (failedPredecessor && (change.owner === attempt.owner || change.owner === claim.previous?.owner)) {
          this.currentSources.delete(change.owner);
          continue;
        }
        if (change.previous) this.currentSources.set(change.owner, change.previous);
        else this.currentSources.delete(change.owner);
      }
    }
    attempt.claims.clear();
  }

  private invalidateOwnerSource(owner: OmpProviderSessionState): void {
    const expected = this.currentSources.get(owner);
    const attempts = new Set<RoutingAttempt>();
    for (const replacement of [...this.replacements.values()]) {
      if (replacement.attempt.replacedOwner === owner) {
        attempts.add(replacement.attempt);
        this.invalidateAttempt(replacement.attempt, replacement.source);
      }
    }
    for (const [transcriptId, route] of this.byTranscript) {
      const attempt = route.attempt;
      if (attempt && transcriptId !== attempt.id
        && (attempt.replacedOwner === owner || route.owner === owner)) attempts.add(attempt);
    }
    for (const attempt of attempts) this.invalidateAttempt(attempt, expected);
    this.currentSources.delete(owner);
  }

  // If no previous transcript/file is available, there is no principled way to
  // decide which other owner survives an alias inference. Retire only those
  // ambiguous candidates; provider IDs joined directly by OMP remain valid.
  invalidateUnknownSource(): void {
    this.transitionEpoch++;
    for (const replacement of [...this.replacements.values()]) {
      this.invalidateAttempt(replacement.attempt, replacement.source);
    }
    for (const [transcriptId, route] of this.byTranscript) {
      const attempt = route.attempt;
      if (attempt && transcriptId !== attempt.id && attempt.replacedOwner) this.invalidateAttempt(attempt);
    }
    this.currentSources.clear();
  }


  // Call from the real session_switch / session_branch listeners after resolving
  // the previous file's header ID. A transition must move this owner's expected
  // source; failure to prove it cannot leave an old replacement eligible.
  noteSourceSwitch(
    reason: "new" | "resume" | "fork" | "branch" | "btw",
    transcriptId: string,
    file: string,
    previousTranscriptId?: string,
    previousFile?: string,
  ): void {
    void reason;
    if (!transcriptId || !file || transcriptId.includes(":side:")) return;
    if (!previousTranscriptId || previousFile === undefined) {
      this.invalidateUnknownSource();
      return;
    }
    const previous = this.byTranscript.get(previousTranscriptId);
    if (!previous?.owner) {
      this.invalidateUnknownSource();
      return;
    }
    const current = this.currentSources.get(previous.owner);
    // A late switch for an older file cannot pull this owner back after a fork.
    // Context/routing IDs may be aliases of the same journal, so file identity
    // rather than their spelling is the continuity check.
    if (current && previous.file !== undefined && current.file !== previous.file) return;
    if (previousFile !== undefined && previous.file !== previousFile) {
      this.invalidateOwnerSource(previous.owner);
      return;
    }

    // A proven transition retires this owner's aliases as well as its unused
    // candidates, so a parent alias cannot keep resolving to a child's runtime.
    this.invalidateOwnerSource(previous.owner);
    this.currentSources.set(previous.owner, { transcriptId, file, epoch: this.transitionEpoch });
    this.byTranscript.set(transcriptId, { id: transcriptId, owner: previous.owner, file });
  }

  take(transcriptId: string, file?: string): string {
    if (transcriptId.includes(":side:")) return transcriptId;
    const attempt = this.pending.get(transcriptId);
    if (attempt) {
      this.removePending(attempt);
      const known = this.byTranscript.get(transcriptId);
      const claim = this.claim(transcriptId,
        { id: transcriptId, owner: attempt.owner, file: file ?? known?.file }, attempt);
      if (file !== undefined) this.changeClaimedSource(claim, attempt.owner, { transcriptId, file });
      const replacement = this.replacementsById.get(transcriptId);
      if (replacement?.attempt === attempt) this.retireReplacement(replacement);
      return transcriptId;
    }
    const known = this.byTranscript.get(transcriptId);
    if (!known) return transcriptId;
    if (file !== undefined && known.owner) {
      const replacement = this.replacements.get(known.owner);
      if (replacement) {
        const candidate = replacement.attempt;
        const oldSource = candidate.replacedOwner ? this.currentSources.get(candidate.replacedOwner) : undefined;
        const newSource = candidate.owner ? this.currentSources.get(candidate.owner) : undefined;
        const current = oldSource === replacement.source
          && (!newSource || newSource === replacement.source);
        // Compare against the candidate's proven source, never merely against
        // the incoming transcript's own file or pending-stream uniqueness.
        if (current && replacement.source.file === file && replacement.epoch === this.transitionEpoch) {
          const claim = this.claim(transcriptId, { id: candidate.id, owner: candidate.owner, file }, candidate);
          this.changeClaimedSource(claim, candidate.owner, replacement.source);
          // A consumed candidate advances current ownership to its new scope;
          // late callbacks that only know the old scope get no stale candidate.
          if (candidate.replacedOwner
            && this.currentSources.get(candidate.replacedOwner) === replacement.source) {
            const change = { owner: candidate.replacedOwner, previous: replacement.source, assigned: undefined };
            claim.sourceChanges.push(change);
            this.currentSources.delete(candidate.replacedOwner);
          }
          this.removePending(candidate);
          this.retireReplacement(replacement);
          return candidate.id;
        }
      }
    }
    if (file !== undefined) known.file ??= file;
    return known.id;
  }

  forget(transcriptId: string, file?: string): string {
    const routingId = this.take(transcriptId, file);
    const route = this.byTranscript.get(transcriptId);
    if (route?.owner) {
      const current = this.currentSources.get(route.owner);
      if (current?.transcriptId === transcriptId) this.currentSources.delete(route.owner);
    }
    this.byTranscript.delete(transcriptId);
    const transcriptAttempt = this.pending.get(transcriptId);
    if (transcriptAttempt) this.removePending(transcriptAttempt);
    const routingAttempt = this.pending.get(routingId);
    if (routingAttempt) this.removePending(routingAttempt);
    const replacement = this.replacementsById.get(routingId);
    if (replacement) this.retireReplacement(replacement);
    return routingId;
  }

  clearPending(): void {
    // Direct pending joins are disposable session-start bookkeeping. Proven
    // replacement candidates and their rollback ownership must survive so a
    // later source event can still consume or fail the current generation.
    this.pending.clear();
  }
}
