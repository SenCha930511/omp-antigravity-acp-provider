import { test } from "node:test";
import assert from "node:assert/strict";
import { createSecretService } from "../extension/secret-service.ts";

test("secret service is only applicable on Linux", async () => {
  const service = createSecretService(async () => "token", "darwin");
  assert.equal(await service.present(), undefined);
  assert.equal(await service.remove(), undefined);
});

test("secret service reports a non-empty lookup as present", async () => {
  const calls: string[][] = [];
  const service = createSecretService(async args => { calls.push(args); return "{\"token\":{}}"; }, "linux");
  assert.equal(await service.present(), true);
  assert.deepEqual(calls, [["lookup", "service", "gemini", "username", "antigravity"]]);
});

test("secret service treats an empty lookup as absent", async () => {
  const service = createSecretService(async () => "", "linux");
  assert.equal(await service.present(), false);
});

test("secret service separates confirmed absence from unavailable and failures", async () => {
  const missing = { code: 1, killed: false, signal: null, stderr: "" };
  const missingService = createSecretService(async () => { throw missing; }, "linux");
  assert.equal(await missingService.present(), false);
  assert.equal(await missingService.remove(), false);

  const unavailable: unknown[] = [
    { code: "ENOENT", killed: false, signal: null },
    { code: null, killed: true, signal: "SIGTERM" },
    { code: 1, killed: false, signal: null, stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY" },
  ];
  for (const error of unavailable) {
    const service = createSecretService(async () => { throw error; }, "linux");
    assert.equal(await service.present(), undefined);
    assert.equal(await service.remove(), undefined);
  }

  const failed = { code: 2, killed: false, signal: null, stderr: "permission denied" };
  const failing = createSecretService(async () => { throw failed; }, "linux");
  await assert.rejects(failing.present(), /Unable to inspect the Antigravity keyring entry/);
  await assert.rejects(failing.remove(), /Unable to remove the Antigravity keyring entry/);
});

test("secret service clear success reports removal", async () => {
  const service = createSecretService(async () => "", "linux");
  assert.equal(await service.remove(), true);
});
