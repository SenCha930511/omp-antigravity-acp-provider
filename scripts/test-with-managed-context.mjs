import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  console.log("Managed-context launcher requires POSIX; skipped on this platform");
} else {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "managed-launcher-")));
  try {
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    const shim = path.join(bin, "omp");
    fs.writeFileSync(shim, `#!/usr/bin/env node
if (process.env.MANAGED_LAUNCHER_TEST_SHIM === "hang") {
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({
    binary: process.env.AGY_ACP_BIN,
    argv: process.argv.slice(2),
    home: process.env.HOME,
    path: process.env.PATH,
  }));
}
`);
    fs.chmodSync(shim, 0o755);
    // The shim's absolute /usr/bin/env must find only our Node interpreter.
    fs.symlinkSync(process.execPath, path.join(bin, "node"));

    // A caller that leaks process.env must select these harmless sentinels,
    // never the real OMP installation, and fail the regression mechanically.
    const inheritedHome = path.join(root, "inherited-home");
    const inheritedBin = path.join(root, "inherited-bin");
    fs.mkdirSync(inheritedBin, { recursive: true });
    const inheritedOmp = path.join(inheritedBin, "omp");
    fs.writeFileSync(inheritedOmp, "#!/bin/sh\nprintf 'inherited OMP must never execute\\n' >&2\nexit 97\n");
    fs.chmodSync(inheritedOmp, 0o755);
    const inheritedAcp = path.join(inheritedHome, ".local", "opt", "agy-acp", "current", "agy_acp_server.par");
    fs.mkdirSync(path.dirname(inheritedAcp), { recursive: true });
    fs.writeFileSync(inheritedAcp, "fixture");
    fs.chmodSync(inheritedAcp, 0o755);
    process.env.HOME = inheritedHome;
    process.env.PATH = inheritedBin;
    process.env.AGY_ACP_BIN = inheritedAcp;

    const launcher = path.join(fileURLToPath(new URL("../", import.meta.url)), "scripts/with-managed-context.sh");
    const defaultTimeout = 5_000;
    const failureDetails = (result, timeoutMs) => {
      const lines = [];
      if (result.error?.code === "ETIMEDOUT") {
        lines.push(`Managed-context launcher timed out after ${timeoutMs} ms`);
      } else if (result.error) {
        lines.push(`Managed-context launcher could not be spawned: ${result.error.message}`);
      } else {
        lines.push(`Managed-context launcher exited with status ${result.status}, signal ${result.signal ?? "none"}`);
      }
      if (result.stderr) lines.push(`stderr:\n${result.stderr.trimEnd()}`);
      if (result.stdout) lines.push(`stdout:\n${result.stdout.trimEnd()}`);
      return lines.join("\n");
    };
    const spawnLauncher = ({ acpBin, hang = false, timeoutMs = defaultTimeout } = {}) => {
      const childEnv = { HOME: home, PATH: bin };
      if (acpBin !== undefined) childEnv.AGY_ACP_BIN = acpBin;
      if (hang) childEnv.MANAGED_LAUNCHER_TEST_SHIM = "hang";
      return spawnSync(launcher, ["--continue", "verify exact arguments"], {
        cwd: root,
        env: childEnv,
        encoding: "utf8",
        timeout: timeoutMs,
      });
    };
    const run = (options = {}) => {
      const result = spawnLauncher(options);
      const details = failureDetails(result, options.timeoutMs ?? defaultTimeout);
      assert.equal(result.error, undefined, details);
      assert.equal(result.status, 0, details);
      return JSON.parse(result.stdout);
    };

    const managed = path.join(home, ".local", "opt", "agy-acp", "current", "agy_acp_server.par");
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, "fixture");
    fs.chmodSync(managed, 0o755);
    assert.deepEqual(run(), {
      binary: managed,
      argv: ["--continue", "verify exact arguments"],
      home,
      path: bin,
    });

    const custom = path.join(root, "custom-acp");
    fs.writeFileSync(custom, "fixture");
    fs.chmodSync(custom, 0o755);
    assert.deepEqual(run({ acpBin: custom }), {
      binary: custom,
      argv: ["--continue", "verify exact arguments"],
      home,
      path: bin,
    });

    const missing = path.join(root, "missing-acp");
    const failed = spawnLauncher({ acpBin: missing });
    const failedDetails = failureDetails(failed, defaultTimeout);
    assert.equal(failed.error, undefined, failedDetails);
    assert.equal(failed.status, 1, failedDetails);
    assert.match(failedDetails, /Managed ACP executable is missing or not executable:/);
    assert.ok(failedDetails.includes(missing), failedDetails);

    const timeoutMs = 250;
    const timedOut = spawnLauncher({ hang: true, timeoutMs });
    const timeoutDetails = failureDetails(timedOut, timeoutMs);
    assert.equal(timedOut.error?.code, "ETIMEDOUT", timeoutDetails);
    assert.equal(timedOut.status, null, timeoutDetails);
    assert.match(timeoutDetails, new RegExp(`timed out after ${timeoutMs} ms`));

    console.log("Managed-context launcher isolation, explicit override, exact argv and failures: PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
