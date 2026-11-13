// Offline regression for managed runtime readiness.
//
// The adapter decides installation from the launch plan alone. A stale wrapper
// left in AGY_ACP_BIN by a previous selection is an environment artifact: it
// must not look like an external runtime and must not suppress installation.
// Every case here uses fixture homes and stub installers; nothing downloads,
// spawns ACP or touches the real user home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveAntigravityAcpLaunch } from "../extension/runtime/acp/antigravity.ts";
import { resolveRuntimeLaunchPlan } from "../extension/runtime/launch.ts";
import { ensureManagedRuntime, prepareManagedRuntime } from "../extension/runtime/managed.ts";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "acp-managed-runtime-"));
const home = path.join(work, "home");
const bin = path.join(work, "bin");
fs.mkdirSync(bin, { recursive: true });

const platform = process.platform;
const managedRoot = path.join(home, ".local", "opt", "agy-acp", "current");
function managedBinary(): string {
  return path.join(managedRoot, "agy_acp_server.par");
}
function installManagedFixture(): void {
  fs.mkdirSync(managedRoot, { recursive: true });
  fs.writeFileSync(managedBinary(), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(managedBinary(), 0o755);
}
function removeManagedFixture(): void {
  fs.rmSync(path.join(home, ".local"), { recursive: true, force: true });
}

function freshStateDir(): string {
  return fs.mkdtempSync(path.join(work, "state-"));
}
function wrapperPath(stateDir: string): string {
  return path.join(stateDir, platform === "win32" ? "agy-acp-cli.cmd" : "agy-acp-cli.sh");
}
// A wrapper this adapter generated in an earlier selection, left behind in the
// environment OMP hands the extension.
function staleWrapper(stateDir: string): string {
  const wrapper = wrapperPath(stateDir);
  fs.writeFileSync(wrapper, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(wrapper, 0o755);
  fs.writeFileSync(path.join(stateDir, "acp-runtime-source.json"), JSON.stringify({
    source: "cli",
    cliPath: path.join(work, "missing-agy"),
    cliVersion: "9.9.9",
  }));
  return wrapper;
}
function emptyPathEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: `${bin}${path.delimiter}/usr/bin:/bin`, ...extra };
}

const envBefore = JSON.stringify(process.env);

try {
  // A fresh managed-auto plan has no spawn target and asks for installation.
  {
    removeManagedFixture();
    const stateDir = freshStateDir();
    const env = emptyPathEnv();
    const plan = await resolveRuntimeLaunchPlan(stateDir, { env, home, platform });
    assert.equal(plan.source, "managed");
    assert.equal(plan.installManaged, true);
    assert.equal(plan.target, undefined);
    let installs = 0;
    const prepared = await prepareManagedRuntime(plan, {
      home,
      platform,
      install: async () => {
        installs += 1;
        installManagedFixture();
      },
    });
    assert.equal(installs, 1, "a fresh managed-auto plan must install once");
    assert.deepEqual(prepared.target, { kind: "direct", value: { command: managedBinary(), args: [] } });
    assert.deepEqual(prepared.quota, { kind: "acp", value: { command: managedBinary(), args: [] } });
    assert.equal(env.AGY_ACP_BIN, undefined, "plan resolution must not write AGY_ACP_BIN");
  }

  // Regression: a stale adapter wrapper in AGY_ACP_BIN with no usable CLI and
  // no managed runtime must still install. The plan carries the intent.
  {
    removeManagedFixture();
    const stateDir = freshStateDir();
    const wrapper = staleWrapper(stateDir);
    const env = emptyPathEnv({ AGY_ACP_BIN: wrapper });
    const plan = await resolveRuntimeLaunchPlan(stateDir, { env, home, platform });
    assert.equal(plan.source, "managed");
    assert.equal(plan.installManaged, true);
    assert.equal(plan.target, undefined, "nothing is spawnable before the install");
    let installs = 0;
    const prepared = await prepareManagedRuntime(plan, {
      home,
      platform,
      install: async () => {
        installs += 1;
        installManagedFixture();
      },
    });
    assert.equal(installs, 1, "a stale wrapper must not suppress the managed install");
    assert.deepEqual(prepared.target, { kind: "direct", value: { command: managedBinary(), args: [] } });
    assert.equal(env.AGY_ACP_BIN, wrapper, "the caller's environment must stay untouched");
  }

  // Regression on the real installer decision: with AGY_ACP_BIN naming the
  // adapter's own stale wrapper, managed intent still reaches the installer.
  {
    removeManagedFixture();
    const stateDir = freshStateDir();
    const wrapper = staleWrapper(stateDir);
    const previous = process.env.AGY_ACP_BIN;
    const previousGeminiHome = process.env.GEMINI_HOME;
    process.env.AGY_ACP_BIN = wrapper;
    process.env.GEMINI_HOME = path.join(work, "gemini-home");
    try {
      // The stale wrapper really is what environment discovery would report.
      assert.equal(resolveAntigravityAcpLaunch().source, "env");
      let installed = 0;
      const release = {
        version: "1.4.5",
        platform: "fixture",
        archive: "fixture.zip",
        archiveSha256: "0".repeat(64),
        archiveBytes: 1,
        binaryName: "agy_acp_server.par" as const,
        binaryBytes: 1,
        harnessName: "localharness_external" as const,
        harnessBytes: 1,
        args: [],
      };
      await ensureManagedRuntime(undefined, {
        resolveLatestRelease: async () => ({ release, officialVersion: release.version }),
        installRuntime: async () => {
          installed += 1;
          installManagedFixture();
          return { version: release.version, changed: true, binary: managedBinary() };
        },
      });
      assert.equal(installed, 1, "managed intent must install even when AGY_ACP_BIN names the adapter wrapper");
      const after = await resolveRuntimeLaunchPlan(stateDir, { env: emptyPathEnv({ AGY_ACP_BIN: wrapper }), home, platform });
      assert.equal(after.source, "managed");
      assert.equal(after.installManaged, true);
      assert.deepEqual(after.target, { kind: "direct", value: { command: managedBinary(), args: [] } });
    } finally {
      if (previous === undefined) delete process.env.AGY_ACP_BIN;
      else process.env.AGY_ACP_BIN = previous;
      if (previousGeminiHome === undefined) delete process.env.GEMINI_HOME;
      else process.env.GEMINI_HOME = previousGeminiHome;
    }
  }

  // An explicit non-wrapper AGY_ACP_BIN stays authoritative and never installs.
  {
    removeManagedFixture();
    const stateDir = freshStateDir();
    const env = emptyPathEnv({ AGY_ACP_BIN: "/opt/custom-agy" });
    const plan = await resolveRuntimeLaunchPlan(stateDir, { env, home, platform });
    assert.equal(plan.source, "env");
    assert.equal(plan.installManaged, false);
    let installs = 0;
    const prepared = await prepareManagedRuntime(plan, { install: async () => { installs += 1; } });
    assert.equal(installs, 0, "an externally pinned runtime must never trigger an install");
    assert.equal(prepared, plan);
  }

  // A managed runtime that is already installed is spawnable as-is.
  {
    installManagedFixture();
    const stateDir = freshStateDir();
    const wrapper = staleWrapper(stateDir);
    const plan = await resolveRuntimeLaunchPlan(stateDir, { env: emptyPathEnv({ AGY_ACP_BIN: wrapper }), home, platform });
    assert.equal(plan.source, "managed");
    assert.equal(plan.installManaged, true);
    assert.ok(plan.target);
    let installs = 0;
    const prepared = await prepareManagedRuntime(plan, { install: async () => { installs += 1; } });
    assert.equal(installs, 0, "an installed managed runtime must not reinstall");
    assert.equal(prepared, plan);
  }

  // An install that leaves nothing behind fails closed with the documented hint.
  {
    removeManagedFixture();
    const stateDir = freshStateDir();
    const plan = await resolveRuntimeLaunchPlan(stateDir, { env: emptyPathEnv(), home, platform });
    assert.equal(plan.installManaged, true);
    await assert.rejects(
      prepareManagedRuntime(plan, { home, platform, install: async () => {} }),
      /still missing after installation/,
    );
  }

  // Readiness never mutates the shared environment.
  assert.equal(JSON.stringify(process.env), envBefore, "managed readiness must not mutate process.env");
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log("managed-runtime: stale-wrapper install, pinned, installed and fail-closed cases passed");
