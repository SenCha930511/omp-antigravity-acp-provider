import { test } from "node:test";
import assert from "node:assert/strict";
import { TranscriptRouting } from "../extension/transcript-routing.ts";

const scopeOwner = () => ({ close() {} });

test("routing maps an exactly matching stream to its transcript", () => {
  const routing = new TranscriptRouting();
  routing.noteStream("transcript-main");
  assert.equal(routing.take("transcript-main"), "transcript-main");
  assert.equal(routing.take("transcript-main"), "transcript-main");
});

test("a new stream is observed only when its exact ID is reported", () => {
  const routing = new TranscriptRouting();
  routing.noteStream("route-old");
  assert.equal(routing.take("route-old"), "route-old");
  routing.noteStream("route-fresh");
  assert.equal(routing.take("route-fresh"), "route-fresh");
  assert.equal(routing.forget("route-fresh"), "route-fresh");
});

test("side streams do not consume the main routing slot or owner transition", () => {
  const routing = new TranscriptRouting(), oldOwner = scopeOwner(), nextOwner = scopeOwner();
  routing.noteStream("route-main", oldOwner);
  assert.equal(routing.take("route-main"), "route-main");
  assert.equal(routing.noteStream("route-main:side:1", nextOwner, oldOwner), undefined);
  assert.equal(routing.take("transcript:side:1"), "transcript:side:1");
  assert.equal(routing.take("route-main"), "route-main");
});

test("a replaced owner scope migrates only its proven source", () => {
  const routing = new TranscriptRouting();
  const oldOwner = scopeOwner(), nextOwner = scopeOwner(), unrelatedOwner = scopeOwner();
  const file = "main.jsonl";
  routing.noteStream("transcript-main", oldOwner);
  routing.noteStream("route-unrelated", unrelatedOwner);
  assert.equal(routing.take("transcript-main", file), "transcript-main");

  routing.noteStream("route-fresh", nextOwner, oldOwner);
  assert.equal(routing.take("transcript-main"), "transcript-main");
  assert.equal(routing.take("transcript-main", "different.jsonl"), "transcript-main");
  assert.equal(routing.take("transcript-main", file), "route-fresh");
  assert.equal(routing.take("transcript-main", file), "route-fresh",
    "late completion with the old transcript identity keeps the current generation");
  assert.equal(routing.take("route-unrelated"), "route-unrelated");
});

test("a forked owner can hand the current source transcript to /fresh", () => {
  const routing = new TranscriptRouting(), oldOwner = scopeOwner(), nextOwner = scopeOwner();
  const parentFile = "parent.jsonl", forkFile = "fork.jsonl";
  routing.noteStream("transcript-parent", oldOwner);
  assert.equal(routing.take("transcript-parent", parentFile), "transcript-parent");
  routing.noteSourceSwitch("fork", "transcript-fork", forkFile, "transcript-parent", parentFile);

  routing.noteStream("route-fresh", nextOwner, oldOwner);
  routing.noteStream("route-unrelated", scopeOwner());
  routing.clearPending();
  assert.equal(routing.take("transcript-fork", forkFile), "route-fresh",
    "an exact proven source selects the fork after pending bookkeeping is cleared");
  assert.equal(routing.take("transcript-fork", forkFile), "route-fresh");
});

test("a failed replacement cannot inherit its former source file", () => {
  const routing = new TranscriptRouting(), oldOwner = scopeOwner(), nextOwner = scopeOwner();
  routing.noteStream("transcript-main", oldOwner);
  routing.take("transcript-main", "main.jsonl");
  const attempt = routing.noteStream("route-failed", nextOwner, oldOwner);
  routing.noteFailure(attempt);
  assert.equal(routing.take("transcript-main", "main.jsonl"), "transcript-main");
});

test("a parent transcript cannot claim the fork's replacement", () => {
  const routing = new TranscriptRouting(), oldOwner = scopeOwner(), nextOwner = scopeOwner();
  routing.noteStream("transcript-parent", oldOwner);
  routing.take("transcript-parent", "parent.jsonl");
  routing.noteSourceSwitch("fork", "transcript-fork", "fork.jsonl", "transcript-parent", "parent.jsonl");
  routing.noteStream("route-fresh-fork", nextOwner, oldOwner);
  assert.equal(routing.take("transcript-parent", "parent.jsonl"), "transcript-parent",
    "the parent's own file equality does not prove that the new stream belongs to it");
  assert.equal(routing.take("transcript-fork", "fork.jsonl"), "route-fresh-fork");
  assert.equal(routing.take("transcript-parent", "parent.jsonl"), "transcript-parent");
});

test("a late parent join cannot move current-source provenance back from a fork", () => {
  const routing = new TranscriptRouting(), oldOwner = scopeOwner(), nextOwner = scopeOwner();
  routing.noteStream("transcript-parent", oldOwner);
  routing.take("transcript-parent", "parent.jsonl");
  routing.noteStream("transcript-parent", oldOwner);
  routing.noteSourceSwitch("fork", "transcript-fork", "fork.jsonl", "transcript-parent", "parent.jsonl");
  assert.equal(routing.take("transcript-parent", "parent.jsonl"), "transcript-parent");
  routing.noteStream("route-fresh-fork", nextOwner, oldOwner);
  assert.equal(routing.take("transcript-parent", "parent.jsonl"), "transcript-parent");
  assert.equal(routing.take("transcript-fork", "fork.jsonl"), "route-fresh-fork");
});

test("failure rolls back a consumed source claim only if that attempt still owns it", () => {
  const routing = new TranscriptRouting();
  const oldOwner = scopeOwner(), nextOwner = scopeOwner(), latestOwner = scopeOwner();
  const file = "main.jsonl";
  routing.noteStream("transcript-main", oldOwner);
  routing.take("transcript-main", file);
  const failed = routing.noteStream("route-failed", nextOwner, oldOwner);
  assert.equal(routing.take("transcript-main", file), "route-failed", "the replacement was consumed before failure");
  const current = routing.noteStream("route-current", latestOwner, nextOwner);
  assert.equal(routing.take("transcript-main", file), "route-current");
  routing.noteFailure(failed);
  assert.equal(routing.take("transcript-main", file), "route-current",
    "an older failure cannot overwrite the newer current generation");
  routing.noteSuccess(current);
  routing.noteFailure(current);
  assert.equal(routing.take("transcript-main", file), "route-current",
    "successful completion leaves the current generation committed");
});

test("a consumed-but-failed generation is removed from its source", () => {
  const routing = new TranscriptRouting(), oldOwner = scopeOwner(), nextOwner = scopeOwner();
  const file = "main.jsonl";
  routing.noteStream("transcript-main", oldOwner);
  routing.take("transcript-main", file);
  const attempt = routing.noteStream("route-failed", nextOwner, oldOwner);
  assert.equal(routing.take("transcript-main", file), "route-failed");
  routing.noteFailure(attempt);
  assert.equal(routing.take("transcript-main", file), "transcript-main");
});

test("same-ID attempt identity and success protect the current generation", () => {
  const routing = new TranscriptRouting();
  const oldOwner = scopeOwner(), nextOwner = scopeOwner(), latestOwner = scopeOwner();
  routing.noteStream("transcript-main", oldOwner);
  routing.take("transcript-main", "main.jsonl");
  const older = routing.noteStream("route-shared", nextOwner, oldOwner);
  assert.equal(routing.take("transcript-main", "main.jsonl"), "route-shared");
  const newer = routing.noteStream("route-shared", latestOwner, nextOwner);
  assert.equal(routing.take("transcript-main", "main.jsonl"), "route-shared");
  routing.noteFailure(older);
  routing.noteSuccess(newer);
  routing.noteFailure(newer);
  assert.equal(routing.take("transcript-main", "main.jsonl"), "route-shared");
});

test("source events after successful completion can still consume the route", () => {
  const routing = new TranscriptRouting(), oldOwner = scopeOwner(), nextOwner = scopeOwner();
  routing.noteStream("transcript-main", oldOwner);
  routing.take("transcript-main", "main.jsonl");
  const attempt = routing.noteStream("route-fresh", nextOwner, oldOwner);
  routing.noteSuccess(attempt);
  routing.clearPending();
  assert.equal(routing.take("transcript-main", "main.jsonl"), "route-fresh");
  routing.noteFailure(attempt);
  assert.equal(routing.take("transcript-main", "main.jsonl"), "route-fresh");
});

test("an unproven transition cannot leave a child candidate claimable by its parent", () => {
  const routing = new TranscriptRouting(), oldOwner = scopeOwner(), nextOwner = scopeOwner();
  const otherOwner = scopeOwner(), otherNextOwner = scopeOwner();
  routing.noteStream("transcript-parent", oldOwner);
  routing.take("transcript-parent", "parent.jsonl");
  routing.noteStream("transcript-other", otherOwner);
  routing.take("transcript-other", "other.jsonl");
  routing.noteStream("route-child", nextOwner, oldOwner);
  routing.noteStream("route-other-next", otherNextOwner, otherOwner);

  routing.noteSourceSwitch("fork", "transcript-fork", "fork.jsonl", "transcript-parent", "wrong.jsonl");
  assert.equal(routing.forget("transcript-parent", "parent.jsonl"), "transcript-parent");
  assert.equal(routing.take("transcript-other", "other.jsonl"), "route-other-next",
    "an invalid transition must not cancel another owner's valid candidate");
});

test("a missing previous header retires ambiguous aliases but preserves direct IDs", () => {
  const routing = new TranscriptRouting(), owner = scopeOwner(), childOwner = scopeOwner();
  const other = scopeOwner(), otherNext = scopeOwner();
  routing.noteStream("transcript-parent", owner);
  routing.take("transcript-parent", "parent.jsonl");
  routing.noteStream("transcript-other", other);
  routing.take("transcript-other", "other.jsonl");
  routing.noteStream("route-child", childOwner, owner);

  routing.noteSourceSwitch("branch", "transcript-branch", "branch.jsonl", undefined, "parent.jsonl");
  assert.equal(routing.take("transcript-parent", "parent.jsonl"), "transcript-parent");
  assert.equal(routing.take("transcript-other", "other.jsonl"), "transcript-other",
    "without a provable prior owner, another alias candidate must not survive blindly");

  routing.noteSourceSwitch("branch", "transcript-other", "other.jsonl", "transcript-other", "other.jsonl");
  routing.noteStream("route-other-next", otherNext, other);
  assert.equal(routing.take("transcript-other", "other.jsonl"), "route-other-next",
    "a newly proven transition may rebuild a healthy owner/source lineage");
});

test("a branch advances the current source before an immediate /fresh", () => {
  const routing = new TranscriptRouting(), owner = scopeOwner(), nextOwner = scopeOwner();
  routing.noteStream("transcript-parent", owner);
  routing.take("transcript-parent", "parent.jsonl");
  routing.noteSourceSwitch("branch", "transcript-branch", "branch.jsonl", "transcript-parent", "parent.jsonl");
  routing.noteStream("route-fresh", nextOwner, owner);
  assert.equal(routing.take("transcript-parent", "parent.jsonl"), "transcript-parent");
  assert.equal(routing.take("transcript-branch", "branch.jsonl"), "route-fresh");
});

test("routing/header aliases do not prevent a valid source transition", () => {
  const routing = new TranscriptRouting(), owner = scopeOwner(), nextOwner = scopeOwner(), latest = scopeOwner();
  routing.noteStream("transcript-original", owner);
  routing.take("transcript-original", "main.jsonl");
  routing.noteStream("route-fresh", nextOwner, owner);
  assert.equal(routing.take("transcript-original", "main.jsonl"), "route-fresh");
  routing.noteStream("route-fresh", nextOwner);
  assert.equal(routing.take("route-fresh", "main.jsonl"), "route-fresh");

  routing.noteSourceSwitch("branch", "transcript-branch", "branch.jsonl", "transcript-original", "main.jsonl");
  routing.noteStream("route-next", latest, nextOwner);
  assert.equal(routing.take("transcript-branch", "branch.jsonl"), "route-next");
});

test("failure of a newer generation cannot restore or reuse its failed predecessor", () => {
  const routing = new TranscriptRouting(), initial = scopeOwner(), first = scopeOwner(), next = scopeOwner();
  const file = "main.jsonl";
  routing.noteStream("transcript-main", initial);
  routing.take("transcript-main", file);
  const a = routing.noteStream("route-failed-first", first, initial);
  assert.equal(routing.take("transcript-main", file), "route-failed-first");
  const b = routing.noteStream("route-failed-second", next, first);
  assert.equal(routing.take("transcript-main", file), "route-failed-second");
  routing.noteFailure(a);
  routing.noteFailure(b);
  assert.equal(routing.take("transcript-main", file), "transcript-main",
    "the older failed generation must not be resurrected, nor may the newer failed generation remain");
  const successor = routing.noteStream("route-unproven", scopeOwner(), next);
  assert.equal(routing.take("transcript-main", file), "transcript-main");
  routing.noteFailure(successor);
});

test("an older failure cannot invalidate a newer source on the same owner", () => {
  const routing = new TranscriptRouting(), initial = scopeOwner(), first = scopeOwner(), next = scopeOwner();
  routing.noteStream("transcript-main", initial);
  routing.take("transcript-main", "main.jsonl");
  const a = routing.noteStream("route-failed-first", first, initial);
  assert.equal(routing.take("transcript-main", "main.jsonl"), "route-failed-first");
  const b = routing.noteStream("route-failed-second", next, first);
  assert.equal(routing.take("transcript-main", "main.jsonl"), "route-failed-second");
  routing.noteFailure(a);

  routing.noteSourceSwitch("fork", "transcript-current", "current.jsonl", "transcript-main", "main.jsonl");
  routing.noteStream("transcript-current", next);
  assert.equal(routing.take("transcript-current", "current.jsonl"), "transcript-current");
  routing.noteFailure(b);
  routing.noteStream("route-current-next", scopeOwner(), next);
  assert.equal(routing.take("transcript-current", "current.jsonl"), "route-current-next",
    "must retain the healthy current source rather than restoring the failed predecessor's evidence");
});

test("same-file source advancement survives an older rollback", () => {
  const routing = new TranscriptRouting(), initial = scopeOwner(), next = scopeOwner();
  routing.noteStream("transcript-main", initial);
  routing.take("transcript-main", "main.jsonl");
  const older = routing.noteStream("route-older", next, initial);
  assert.equal(routing.take("transcript-main", "main.jsonl"), "route-older");
  routing.noteSourceSwitch("new", "transcript-current", "main.jsonl", "transcript-main", "main.jsonl");
  routing.noteFailure(older);
  routing.noteStream("route-fresh", scopeOwner(), next);
  assert.equal(routing.take("transcript-current", "main.jsonl"), "route-fresh",
    "a new assignment on the same file must not be deleted by its predecessor's rollback");
});

test("an unproven prior transition blocks stale aliases until a proven source rebuilds them", () => {
  const routing = new TranscriptRouting(), owner = scopeOwner();
  routing.noteStream("transcript-parent", owner);
  routing.take("transcript-parent", "old.jsonl");
  routing.noteSourceSwitch("new", "transcript-current", "new.jsonl", "transcript-parent", "old.jsonl");
  routing.noteStream("route-current", scopeOwner(), owner);
  routing.noteSourceSwitch("branch", "transcript-stale", "stale.jsonl", undefined, "old.jsonl");
  assert.equal(routing.take("transcript-current", "new.jsonl"), "transcript-current",
    "unprovable prior metadata must not leave anonymous source aliases eligible");

  routing.noteSourceSwitch("branch", "transcript-current", "new.jsonl", "transcript-parent", "old.jsonl");
  routing.noteStream("route-current", scopeOwner(), owner);
  assert.equal(routing.take("transcript-current", "new.jsonl"), "route-current",
    "a newly proven transition can safely rebuild the current source");
});

test("invalidation removes a claimed parent alias without deleting the child's direct route", () => {
  const routing = new TranscriptRouting(), parent = scopeOwner(), child = scopeOwner();
  routing.noteStream("transcript-parent", parent);
  routing.take("transcript-parent", "parent.jsonl");
  const claimed = routing.noteStream("route-child", child, parent);
  assert.equal(routing.take("transcript-parent", "parent.jsonl"), "route-child");
  const direct = routing.noteStream("route-child", child);
  assert.equal(routing.take("route-child", "parent.jsonl"), "route-child");

  routing.noteSuccess(claimed);
  routing.noteSourceSwitch("fork", "transcript-fork", "fork.jsonl", "transcript-parent", "wrong.jsonl");
  assert.equal(routing.take("transcript-parent", "parent.jsonl"), "transcript-parent");
  routing.noteFailure(claimed);
  assert.equal(routing.take("route-child", "parent.jsonl"), "route-child", "the direct provider-ID route stays intact");
  routing.noteSuccess(direct);
});

test("unknown previous metadata cannot leave a claimed alias, but preserves exact IDs", () => {
  const routing = new TranscriptRouting(), initial = scopeOwner(), next = scopeOwner();
  routing.noteStream("transcript-parent", initial);
  routing.take("transcript-parent", "parent.jsonl");
  const alias = routing.noteStream("route-child", next, initial);
  assert.equal(routing.take("transcript-parent", "parent.jsonl"), "route-child");
  routing.noteStream("direct-other", scopeOwner());
  routing.take("direct-other", "other.jsonl");

  routing.noteSuccess(alias);
  routing.noteSourceSwitch("fork", "transcript-fork", "fork.jsonl");
  assert.equal(routing.take("transcript-parent", "parent.jsonl"), "transcript-parent");
  assert.equal(routing.forget("transcript-parent", "parent.jsonl"), "transcript-parent");
  assert.equal(routing.take("direct-other", "other.jsonl"), "direct-other");
  routing.noteFailure(alias);
});

test("a child created after an unknown transition cannot inherit the old source", () => {
  const routing = new TranscriptRouting(), owner = scopeOwner();
  routing.noteStream("transcript-parent", owner);
  routing.take("transcript-parent", "parent.jsonl");
  routing.noteSourceSwitch("fork", "transcript-fork", "fork.jsonl");
  routing.noteStream("route-child", scopeOwner(), owner);
  assert.equal(routing.take("transcript-parent", "parent.jsonl"), "transcript-parent");

  routing.noteSourceSwitch("fork", "transcript-fork", "fork.jsonl", "transcript-parent", "parent.jsonl");
  routing.noteStream("route-próbable-child", scopeOwner(), owner);
  assert.equal(routing.take("transcript-fork", "fork.jsonl"), "route-próbable-child",
    "a later proven transition establishes a fresh source/eligible generation");
});

test("headerless relocation cannot make a parent claim a child or its future replacement", () => {
  const routing = new TranscriptRouting(), parent = scopeOwner();
  routing.noteStream("transcript-parent", parent);
  routing.take("transcript-parent", "old.jsonl");
  const child = routing.noteStream("route-child", scopeOwner(), parent);
  routing.noteSourceSwitch("fork", "transcript-moved", "moved.jsonl", undefined, "moved.jsonl");
  assert.equal(routing.take("transcript-parent", "old.jsonl"), "transcript-parent");

  routing.noteStream("route-after-unknown", scopeOwner(), parent);
  assert.equal(routing.take("transcript-parent", "old.jsonl"), "transcript-parent");
  routing.noteFailure(child);

  routing.noteSourceSwitch("branch", "transcript-moved", "moved.jsonl", "transcript-parent", "old.jsonl");
  routing.noteStream("route-rebuilt", scopeOwner(), parent);
  assert.equal(routing.take("transcript-moved", "moved.jsonl"), "route-rebuilt",
    "only a newly proven transition may reconstruct the alias lineage");
});

test("a successful child alias cannot survive a proven fork source transition", () => {
  const routing = new TranscriptRouting(), owner = scopeOwner(), nextOwner = scopeOwner();
  routing.noteStream("transcript-parent", owner);
  routing.take("transcript-parent", "parent.jsonl");
  const claimed = routing.noteStream("route-child", nextOwner, owner);
  assert.equal(routing.take("transcript-parent", "parent.jsonl"), "route-child");
  routing.noteSuccess(claimed);
  const direct = routing.noteStream("route-child", nextOwner);
  assert.equal(routing.take("route-child", "parent.jsonl"), "route-child");

  routing.noteSourceSwitch("fork", "transcript-fork", "fork.jsonl", "transcript-parent", "parent.jsonl");
  assert.equal(routing.take("transcript-parent", "parent.jsonl"), "transcript-parent");
  assert.equal(routing.forget("transcript-parent", "parent.jsonl"), "transcript-parent");
  assert.equal(routing.take("route-child", "parent.jsonl"), "route-child",
    "only the parent alias is removed; the child's own direct routing ID is preserved");
  routing.noteSuccess(direct);
});

test("an unproven owner replacement cannot claim a pending stream", () => {
  const routing = new TranscriptRouting();
  routing.noteStream("route-busy", scopeOwner());
  routing.noteStream("route-candidate", scopeOwner(), scopeOwner());
  assert.equal(routing.take("transcript-other"), "transcript-other");
  assert.equal(routing.forget("transcript-other"), "transcript-other");
  assert.equal(routing.take("route-candidate"), "route-candidate");
  assert.equal(routing.take("route-busy"), "route-busy");
});

test("a candidate cannot be stolen by an unrelated source with the same file", () => {
  const routing = new TranscriptRouting(), owner = scopeOwner(), otherOwner = scopeOwner();
  routing.noteStream("transcript-main", owner);
  routing.take("transcript-main", "shared-name.jsonl");
  routing.noteStream("transcript-other", otherOwner);
  routing.take("transcript-other", "shared-name.jsonl");
  routing.noteStream("route-fresh", scopeOwner(), owner);
  assert.equal(routing.take("transcript-other", "shared-name.jsonl"), "transcript-other");
  assert.equal(routing.take("transcript-unknown", "shared-name.jsonl"), "transcript-unknown");
  assert.equal(routing.take("transcript-main", "shared-name.jsonl"), "route-fresh");
});

for (const reason of ["new", "resume", "fork", "branch", "btw"] as const) {
  test(`a proven ${reason} switch moves the replacement target to the new source`, () => {
    const routing = new TranscriptRouting(), oldOwner = scopeOwner(), nextOwner = scopeOwner();
    routing.noteStream("transcript-old", oldOwner);
    routing.take("transcript-old", "old.jsonl");
    routing.noteSourceSwitch(reason, "transcript-new", "new.jsonl", "transcript-old", "old.jsonl");
    routing.noteStream("route-fresh", nextOwner, oldOwner);
    assert.equal(routing.take("transcript-old", "old.jsonl"), "transcript-old");
    assert.equal(routing.take("transcript-new", "new.jsonl"), "route-fresh");
  });
}

test("a source switch with unproven previous identity fails closed", () => {
  const routing = new TranscriptRouting(), owner = scopeOwner();
  routing.noteStream("transcript-old", owner);
  routing.take("transcript-old", "old.jsonl");
  routing.noteSourceSwitch("fork", "transcript-new", "new.jsonl", "transcript-old", "wrong.jsonl");
  routing.noteStream("route-fresh", scopeOwner(), owner);
  assert.equal(routing.take("transcript-new", "new.jsonl"), "transcript-new");
  assert.equal(routing.take("transcript-old", "old.jsonl"), "transcript-old",
    "unproven transition must invalidate the old candidate, not let the parent claim it");
});

test("a failed direct join does not leave source evidence for later replacements", () => {
  const routing = new TranscriptRouting(), owner = scopeOwner();
  const attempt = routing.noteStream("transcript-direct", owner);
  assert.equal(routing.take("transcript-direct", "direct.jsonl"), "transcript-direct");
  routing.noteFailure(attempt);
  routing.noteStream("route-unproven", scopeOwner(), owner);
  assert.equal(routing.take("transcript-direct", "direct.jsonl"), "transcript-direct");
});

test("ambiguous concurrent streams fail closed instead of guessing", () => {
  const routing = new TranscriptRouting();
  routing.noteStream("route-a");
  routing.noteStream("route-b");
  assert.equal(routing.take("transcript-a"), "transcript-a");
  assert.equal(routing.take("route-a"), "route-a");
  assert.equal(routing.take("transcript-b"), "transcript-b");
  assert.equal(routing.take("route-b"), "route-b");
});

test("ambiguity clears after both concurrent streams are consumed", () => {
  const routing = new TranscriptRouting();
  routing.noteStream("route-a");
  routing.noteStream("route-b");
  assert.equal(routing.take("route-a"), "route-a");
  assert.equal(routing.take("route-b"), "route-b");
  routing.noteStream("route-c");
  assert.equal(routing.take("route-c"), "route-c");
});

test("a single pending stream cannot be claimed by another transcript", () => {
  const routing = new TranscriptRouting();
  routing.noteStream("route-busy");
  assert.equal(routing.take("transcript-other"), "transcript-other");
  assert.equal(routing.forget("transcript-other"), "transcript-other",
    "shutdown of another transcript must not claim the active routing identity");
  routing.clearPending();
  routing.noteStream("route-after-switch");
  assert.equal(routing.take("transcript-old"), "transcript-old",
    "late completion cannot claim the new session's sole pending identity");
  assert.equal(routing.take("route-after-switch"), "route-after-switch",
    "the original pending stream must remain claimable by its own ID");
});

test("failed streams release their pending routing id", () => {
  const routing = new TranscriptRouting();
  const attempt = routing.noteStream("route-failed");
  routing.noteFailure(attempt);
  assert.equal(routing.take("transcript-next"), "transcript-next");
});

test("forget and clearPending remove stale attribution", () => {
  const routing = new TranscriptRouting();
  routing.noteStream("transcript-main");
  assert.equal(routing.take("transcript-main"), "transcript-main");
  routing.forget("transcript-main");
  assert.equal(routing.take("transcript-main"), "transcript-main");

  routing.noteStream("route-a");
  routing.noteStream("route-b");
  routing.clearPending();
  assert.equal(routing.take("transcript-c"), "transcript-c");
});

test("forget retires the current owner lineage and later replacements cannot resurrect it", () => {
  const routing = new TranscriptRouting();
  const oldOwner = scopeOwner(), nextOwner = scopeOwner(), laterOwner = scopeOwner();
  const file = "main.jsonl";
  routing.noteStream("transcript-main", oldOwner);
  assert.equal(routing.take("transcript-main", file), "transcript-main");
  routing.noteStream("route-fresh", nextOwner, oldOwner);
  routing.clearPending();
  assert.equal(routing.take("transcript-main", file), "route-fresh",
    "clearing pending streams does not erase an established owner generation");
  assert.equal(routing.forget("transcript-main", file), "route-fresh",
    "shutdown closes the current generation rather than a residual pending ID");

  routing.clearPending();
  routing.noteStream("route-after-shutdown", laterOwner, nextOwner);
  assert.equal(routing.take("transcript-main", file), "transcript-main");
  assert.equal(routing.take("route-after-shutdown", file), "route-after-shutdown");
});

test("superseded candidates and old owner callbacks cannot resurrect stale routes", () => {
  const routing = new TranscriptRouting();
  const oldOwner = scopeOwner(), nextOwner = scopeOwner(), latestOwner = scopeOwner();
  routing.noteStream("transcript-main", oldOwner);
  routing.take("transcript-main", "main.jsonl");
  routing.noteStream("route-stale", scopeOwner(), oldOwner);
  routing.noteStream("route-current", nextOwner, oldOwner);
  assert.equal(routing.take("transcript-main", "main.jsonl"), "route-current");
  routing.noteStream("route-late-old-owner", scopeOwner(), oldOwner);
  assert.equal(routing.take("transcript-main", "main.jsonl"), "route-current");
  routing.noteStream("route-next", latestOwner, nextOwner);
  routing.clearPending();
  assert.equal(routing.take("transcript-main", "main.jsonl"), "route-next");
});
