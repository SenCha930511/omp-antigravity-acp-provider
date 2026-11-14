import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { quotaFromPrompt } from "../extension/runtime/status.ts";
import { fetchCliQuota } from "../extension/usage-accounting.ts";
import { resolveCommandProbe } from "../extension/runtime/launch.ts";
import type { PromptResponse } from "@agentclientprotocol/sdk";

test("CLI quota runs the selected CLI's print-mode /usage without an ACP connection", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cli-quota-"));
  const cli = path.join(directory, "agy");
  const argsFile = path.join(directory, "args");
  fs.writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf 'Gemini Models\\tWeekly Limit Remaining\\t40%%\\t2026-11-14T13:50:05Z\\n'\n`);
  fs.chmodSync(cli, 0o755);
  try {
    const snapshot = await fetchCliQuota(cli);
    assert.deepEqual(snapshot.groups, [{
      displayName: "Gemini Models",
      buckets: [{ window: "weekly", remainingFraction: 0.4, resetTime: "2026-11-14T13:50:05.000Z" }],
    }]);
    assert.deepEqual(fs.readFileSync(argsFile, "utf8").trim().split("\n"), ["--app_data_dir=antigravity-acp", "-p", "/usage"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows .cmd quota goes through cmd.exe without shell mode or losing arguments", () => {
  const cli = "C:\\Program Files (x86)\\Team & Tools\\agy.cmd";
  const args = ["--app_data_dir=antigravity-acp", "-p", "/usage"];
  assert.deepEqual(resolveCommandProbe(cli, args, "win32"), {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/e:on", "/v:off", "/c", `call "${cli}"`, ...args],
  });
  assert.deepEqual(resolveCommandProbe(cli, args, "darwin"), { command: cli, args });
  assert.throws(() => resolveCommandProbe("C:\\Users\\%jane%\\agy.cmd", [], "win32"), /percent signs/);
  assert.deepEqual(resolveCommandProbe("~/bin/100%/agy", args, "darwin"), { command: "~/bin/100%/agy", args });
});

const quotaPrompt = (quota: Record<string, unknown>): PromptResponse =>
  ({ stopReason: "end_turn", _meta: { quota } }) as unknown as PromptResponse;

test("numeric quota resets keep valid values and omit malformed ones without throwing", () => {
  const seconds = quotaFromPrompt(quotaPrompt({ remainingRequests: 12, requestLimit: 100, resetTimestamp: 1_700_000_000 }));
  assert.equal(seconds?.remaining, 12);
  assert.equal(seconds?.limit, 100);
  assert.equal(seconds?.resetAt, new Date(1_700_000_000_000).toISOString());

  const milliseconds = quotaFromPrompt(quotaPrompt({ resetAt: 1_700_000_000_000 }));
  assert.equal(milliseconds?.resetAt, new Date(1_700_000_000_000).toISOString());

  const unsafe = quotaFromPrompt(quotaPrompt({ remainingRequests: 3, requestLimit: 10, resetTimestamp: 1e20 }));
  assert.deepEqual(unsafe, { remaining: 3, limit: 10 }, "an unsafe reset must not discard remaining/limit metadata");

  const outOfRange = quotaFromPrompt(quotaPrompt({ remaining: 1, resetAt: 8.64e15 + 1 }));
  assert.deepEqual(outOfRange, { remaining: 1 });

  const notFinite = quotaFromPrompt(quotaPrompt({ remaining: 2, resetAt: Number.POSITIVE_INFINITY }));
  assert.deepEqual(notFinite, { remaining: 2 });

  assert.equal(quotaFromPrompt(quotaPrompt({ resetAt: "2026-11-14T13:50:00.000Z" }))?.resetAt,
    "2026-11-14T13:50:00.000Z", "string timestamps remain valid");
});
