import { test } from "node:test";
import assert from "node:assert/strict";
import { TranscriptRouting } from "../extension/transcript-routing.ts";

test("routing maps one completed stream to its transcript", () => {
  const routing = new TranscriptRouting();
  routing.noteStream("route-main");
  assert.equal(routing.take("transcript-main"), "route-main");
  assert.equal(routing.take("transcript-main"), "route-main");
});

test("a new pending stream refreshes a known transcript mapping", () => {
  const routing = new TranscriptRouting();
  routing.noteStream("route-old");
  assert.equal(routing.take("transcript-main"), "route-old");
  routing.noteStream("route-fresh");
  assert.equal(routing.take("transcript-main"), "route-fresh");
  assert.equal(routing.take("transcript-main"), "route-fresh");
});

test("side streams do not consume the main routing slot", () => {
  const routing = new TranscriptRouting();
  routing.noteStream("route-main");
  routing.noteStream("route-main:side:1");
  assert.equal(routing.take("transcript:side:1"), "transcript:side:1");
  assert.equal(routing.take("transcript-main"), "route-main");
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
  assert.equal(routing.take("transcript-c"), "route-c");
});

test("failed streams release their pending routing id", () => {
  const routing = new TranscriptRouting();
  routing.noteStream("route-failed");
  routing.noteFailure("route-failed");
  assert.equal(routing.take("transcript-next"), "transcript-next");
});

test("forget and clearPending remove stale attribution", () => {
  const routing = new TranscriptRouting();
  routing.noteStream("route-main");
  assert.equal(routing.take("transcript-main"), "route-main");
  routing.forget("transcript-main");
  assert.equal(routing.take("transcript-main"), "transcript-main");

  routing.noteStream("route-a");
  routing.noteStream("route-b");
  routing.clearPending();
  assert.equal(routing.take("transcript-c"), "transcript-c");
});
