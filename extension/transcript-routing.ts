// OMP's session events expose a transcript ID, while streamSimple receives the
// provider routing ID. They are usually equal, but /fresh can rotate one without
// the other. Keep attribution fail-closed when multiple streams are in flight:
// guessing there would bind cleanup evidence to the wrong conversation.
export class TranscriptRouting {
  private readonly byTranscript = new Map<string, string>();
  private readonly pending = new Set<string>();
  private ambiguous = false;

  noteStream(id: string | undefined): void {
    if (!id || id.includes(":side:")) return;
    this.pending.add(id);
    if (this.pending.size > 1) this.ambiguous = true;
  }

  noteFailure(id: string | undefined): void {
    if (!id) return;
    this.pending.delete(id);
    if (!this.pending.size) this.ambiguous = false;
  }

  take(transcriptId: string): string {
    if (transcriptId.includes(":side:")) return transcriptId;
    if (this.pending.delete(transcriptId)) {
      this.byTranscript.set(transcriptId, transcriptId);
      if (!this.pending.size) this.ambiguous = false;
      return transcriptId;
    }
    if (!this.ambiguous && this.pending.size === 1) {
      const [id] = this.pending;
      this.pending.delete(id!);
      this.byTranscript.set(transcriptId, id!);
      return id!;
    }
    const known = this.byTranscript.get(transcriptId);
    if (known) return known;
    return transcriptId;
  }

  forget(transcriptId: string): void {
    this.byTranscript.delete(transcriptId);
    this.pending.delete(transcriptId);
    if (!this.pending.size) this.ambiguous = false;
  }

  clearPending(): void {
    this.pending.clear();
    this.ambiguous = false;
  }
}
