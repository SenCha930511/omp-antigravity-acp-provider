// The launch plan's spawn target must reach the owned supervisor. These cases
// are pure: no ACP session, no child process and no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveLaunchSpawn, resolveLaunchTarget, writeCliWrapper, type RuntimeLaunchPlan } from "../extension/runtime/launch.ts";
import { resolveProcessSpawn, resolveSupervisorEntry } from "../extension/runtime/process.ts";

const cwd = process.cwd();

function wrapperFixture(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-supervised-launch-"));
  const wrapper = path.join(directory, "agy-acp-cli.sh");
  fs.writeFileSync(wrapper, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

function wrapperPlan(wrapper: string): RuntimeLaunchPlan {
  return {
    source: "cli",
    target: {
      kind: "wrapper",
      path: wrapper,
      sha256: createHash("sha256").update(fs.readFileSync(wrapper)).digest("hex"),
    },
    quota: { kind: "cli", cliPath: "/opt/agy" },
    installManaged: false,
    cliPath: "/opt/agy",
    cliVersion: "1.5.3",
  };
}

test("a launch record is spawned through the supervisor", () => {
  const spawn = resolveProcessSpawn({ cwd, launch: { command: "/opt/agy-wrapper", args: ["--app_data_dir=antigravity-acp"] } });
  assert.equal(spawn.command, process.execPath);
  assert.equal(spawn.args[0], resolveSupervisorEntry());
  assert.equal(spawn.args[1], "--command");
  assert.deepEqual(spawn.args.slice(2), ["/opt/agy-wrapper", "--app_data_dir=antigravity-acp"]);
  assert.ok(fs.existsSync(resolveSupervisorEntry()), "the supervisor asset must be published");
  assert.match(resolveSupervisorEntry(), /assets[\\/]src[\\/]acp[\\/]supervisor\.mjs$/);
});

test("a direct command keeps fixture semantics and bypasses the supervisor", () => {
  const spawn = resolveProcessSpawn({ cwd, command: process.execPath, args: ["-e", "process.exit(0)"] });
  assert.deepEqual(spawn, { command: process.execPath, args: ["-e", "process.exit(0)"] });
});

test("a bare entry still goes through the supervisor with node resolution", () => {
  const spawn = resolveProcessSpawn({ cwd, entryPath: "/tmp/fixture-entry.mjs", args: ["--flag"] });
  assert.equal(spawn.command, process.execPath);
  assert.deepEqual(spawn.args.slice(0, 3), [resolveSupervisorEntry(), "--command", process.execPath]);
  assert.deepEqual(spawn.args.slice(3), ["/tmp/fixture-entry.mjs", "--flag"]);
});

test("plan spawning verifies the wrapper bytes before naming the spawned path", () => {
  const wrapper = wrapperFixture();
  const plan = wrapperPlan(wrapper);
  assert.deepEqual(resolveLaunchTarget(plan), { command: wrapper, args: [] });

  fs.writeFileSync(wrapper, "#!/bin/sh\necho tampered\n");
  assert.throws(() => resolveLaunchTarget(plan), /changed after selection/);

  const executable = wrapperFixture();
  const fresh = wrapperPlan(executable);
  fs.chmodSync(executable, 0o644);
  assert.throws(() => resolveLaunchTarget(fresh), /not executable/);

  fs.rmSync(executable, { force: true });
  assert.throws(() => resolveLaunchTarget(fresh), /missing/);
});

test("the direct spawn form keeps the Windows command-processor wrapper", () => {
  const wrapper = wrapperFixture();
  const plan = wrapperPlan(wrapper);
  assert.deepEqual(resolveLaunchSpawn(plan, "linux"), { command: wrapper, args: [] });
  const winSpawn = resolveLaunchSpawn(plan, "win32");
  assert.equal(winSpawn.command, process.env.ComSpec ?? "cmd.exe");
  assert.deepEqual(winSpawn.args, ["/d", "/s", "/c", `call "${wrapper}"`]);
});

test("a plan without a spawn target fails closed", () => {
  const pending: RuntimeLaunchPlan = { source: "managed", quota: { kind: "none" }, installManaged: true };
  assert.throws(() => resolveLaunchTarget(pending), /No ACP runtime is installed/);
});

test("repeated selection repairs lost execute bits on an identical wrapper", () => {
  const wrapper = wrapperFixture();
  const script = fs.readFileSync(wrapper, "utf8");
  const plan = wrapperPlan(wrapper);
  fs.chmodSync(wrapper, 0o644);
  assert.throws(() => resolveLaunchTarget(plan), /not executable/);

  writeCliWrapper(wrapper, script);
  assert.equal(fs.readFileSync(wrapper, "utf8"), script, "repair must not rewrite the bytes");
  assert.equal(fs.statSync(wrapper).mode & 0o111, 0o111, "the wrapper must become executable");
  assert.deepEqual(resolveLaunchTarget(plan), { command: wrapper, args: [] });

  writeCliWrapper(wrapper, script);
  assert.deepEqual(resolveLaunchTarget(plan), { command: wrapper, args: [] }, "repeated selection is idempotent");
});
