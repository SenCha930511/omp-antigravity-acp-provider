import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The item the Antigravity ACP server stores its Google refresh token in on
// Linux: `service=gemini`, `username=antigravity`.
const LOOKUP = ["lookup", "service", "gemini", "username", "antigravity"];
const CLEAR = ["clear", "service", "gemini", "username", "antigravity"];

const INSPECT_FAILURE = "Unable to inspect the Antigravity keyring entry";
const REMOVE_FAILURE = "Unable to remove the Antigravity keyring entry";

// stderr of a Secret Service client that has no usable keyring to talk to.
// Matched in memory only: captured stderr is never logged, persisted, or put
// into an error message.
const UNAVAILABLE_STDERR = /autolaunch D-Bus|StartServiceByName for org\.freedesktop\.secrets|org\.freedesktop\.secret|No such interface|secret service|Secret Service|keyring|Keyring|locked|Locked|D-Bus|DBus/;

// The real secret-tool boundary, with its own binary parameter so tests can
// drive a stub executable through the same code path. argv-only: no shell
// interpolation, a hard timeout, and a bounded capture buffer.
export function runSecretTool(args: string[], bin = "secret-tool"): Promise<string> {
  const options = { timeout: 3000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"] as const, encoding: "utf8" as const };
  return execFileAsync(bin, args, options).then(result => String(result.stdout));
}

interface ExecFailure {
  code?: unknown;
  killed?: unknown;
  signal?: unknown;
  stderr?: unknown;
}

function execFailure(error: unknown): ExecFailure | undefined {
  return typeof error === "object" && error !== null ? error as ExecFailure : undefined;
}

function terminated(failure: ExecFailure): boolean {
  return failure.killed === true || typeof failure.signal === "string";
}

function serviceUnavailable(failure: ExecFailure): boolean {
  return failure.code === "ENOENT"
    || (typeof failure.stderr === "string" && UNAVAILABLE_STDERR.test(failure.stderr));
}

// Linux Secret Service operations behind one mutable object so offline command
// tests can substitute them without touching the user's real keyring.
// present/remove resolve to true (present / removed), false (confirmed absent),
// or undefined (no usable keyring, so the item is neither confirmed absent nor
// removed). A lookup answer is only the presence of non-empty stdout: the
// secret itself is dropped immediately and never cached, logged or persisted.
export function createSecretService(run: (args: string[]) => Promise<string>, platform: NodeJS.Platform = process.platform) {
  const present = async (): Promise<boolean | undefined> => {
    try {
      const stdout = await run(LOOKUP);
      return stdout.trim().length > 0;
    } catch (error) {
      const failure = execFailure(error);
      if (failure && (terminated(failure) || serviceUnavailable(failure))) return undefined;
      if (failure?.code === 1) return false;
      throw new Error(INSPECT_FAILURE);
    }
  };
  const remove = async (): Promise<boolean | undefined> => {
    try {
      await run(CLEAR);
      return true;
    } catch (error) {
      const failure = execFailure(error);
      // `clear` exits 1 when there is nothing to delete; any other exit status
      // is an unexpected failure. An unreachable keyring is never reported as
      // removed, and a failed or unconfirmed clear is never reported as
      // success.
      if (failure?.code === 1) return serviceUnavailable(failure) ? undefined : false;
      if (failure && (terminated(failure) || serviceUnavailable(failure))) return undefined;
      throw new Error(REMOVE_FAILURE);
    }
  };
  return {
    applicable: platform === "linux",
    present: (): Promise<boolean | undefined> => platform === "linux" ? present() : Promise.resolve(undefined),
    remove: (): Promise<boolean | undefined> => platform === "linux" ? remove() : Promise.resolve(undefined),
  };
}
