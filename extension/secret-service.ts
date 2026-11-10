import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Linux Secret Service coordinates used by the agy CLI for the Google OAuth
 * token. The ACP server reads the same item (`keyringAuth`), so a token here
 * is a valid local login even when no acp_token.json exists. */
export const SECRET_SERVICE = "gemini";
export const SECRET_ACCOUNT = "antigravity";

const SECRET_TOOL = "secret-tool";
const SECRET_TOOL_TIMEOUT_MS = 3_000;

export interface SecretService {
  /** true: a non-empty token is stored; false: confirmed absent; undefined:
   * not Linux or the keyring is unreachable (no secret-tool/D-Bus). */
  present: () => Promise<boolean | undefined>;
  /** true: removed; false: confirmed absent; undefined: not applicable. */
  remove: () => Promise<boolean | undefined>;
}

// The secret-tool subprocess boundary. stdout is only checked for a non-empty
// token and is never logged or persisted. Tests inject a stub runner.
export async function runSecretTool(args: string[], bin = SECRET_TOOL): Promise<string> {
  const { stdout } = await execFileAsync(bin, args, {
    encoding: "utf8",
    timeout: SECRET_TOOL_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return typeof stdout === "string" ? stdout : stdout.toString("utf8");
}

function errorDetail(error: unknown): { killed?: unknown; signal?: unknown; code?: unknown; stderr?: unknown } | undefined {
  return error && typeof error === "object"
    ? error as { killed?: unknown; signal?: unknown; code?: unknown; stderr?: unknown }
    : undefined;
}

// secret-tool exits 1 when no item matches. A D-Bus/keyring failure also exits
// non-zero, so its stderr must not be mistaken for a confirmed absence.
function isUnavailable(error: unknown): boolean {
  const detail = errorDetail(error);
  if (!detail) return false;
  if (detail.code === "ENOENT" || detail.code === "ETIMEDOUT" || detail.killed === true || detail.signal != null) return true;
  return typeof detail.stderr === "string"
    && /(?:D-Bus|DBus|dbus|session bus|secret service|keyring|locked|timed out)/i.test(detail.stderr);
}

function isConfirmedMissing(error: unknown): boolean {
  const detail = errorDetail(error);
  return Boolean(detail && detail.killed !== true && detail.signal == null && detail.code === 1 && !isUnavailable(error));
}

export function createSecretService(
  run: (args: string[]) => Promise<string>,
  platform: NodeJS.Platform = process.platform,
): SecretService {
  const attributes = ["service", SECRET_SERVICE, "username", SECRET_ACCOUNT];
  const check = async (args: string[], failure: string, success: (stdout: string) => boolean): Promise<boolean | undefined> => {
    if (platform !== "linux") return undefined;
    try {
      return success(await run(args));
    } catch (error) {
      if (isUnavailable(error)) return undefined;
      if (isConfirmedMissing(error)) return false;
      throw new Error(failure);
    }
  };
  return {
    present: () => check(["lookup", ...attributes], "Unable to inspect the Antigravity keyring entry", stdout => stdout.trim().length > 0),
    remove: () => check(["clear", ...attributes], "Unable to remove the Antigravity keyring entry", () => true),
  };
}

export const secretService = createSecretService(runSecretTool);
