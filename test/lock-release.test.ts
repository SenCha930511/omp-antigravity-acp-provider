import assert from "node:assert/strict";
import test from "node:test";

import { releaseAfter } from "../extension/lock-release.ts";

const failure = (message: string) => async () => {
  throw new Error(message);
};

test("a release failure does not replace the primary error", async () => {
  const primary = new Error("primary");
  await assert.rejects(async () => {
    let failed = false;
    try {
      failed = true;
      throw primary;
    } finally {
      await releaseAfter(failure("release"), failed);
    }
  }, error => error === primary);
});

test("a release failure surfaces when the work succeeded", async () => {
  await assert.rejects(releaseAfter(failure("release"), false), /release/);
});

test("a compromised lock wins over a release failure", async () => {
  const compromised = new Error("compromised");
  await assert.rejects(releaseAfter(failure("release"), false, compromised), error => error === compromised);
});

test("a primary error wins over a compromised lock and release failure", async () => {
  const primary = new Error("primary");
  const compromised = new Error("compromised");
  await assert.rejects(async () => {
    let failed = false;
    try {
      failed = true;
      throw primary;
    } finally {
      await releaseAfter(failure("release"), failed, compromised);
    }
  }, error => error === primary);
});

test("a compromised lock surfaces after a successful release", async () => {
  const compromised = new Error("compromised");
  await assert.rejects(releaseAfter(async () => {}, false, compromised), error => error === compromised);
});
