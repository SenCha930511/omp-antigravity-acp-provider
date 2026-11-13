// A separate process for the registry lock: it owns its own module state and
// transaction queue, exactly like another OMP process. Bun loads the TypeScript
// source directly, so this always contends against the code under test.
import { SessionCleanup } from "../../extension/session-cleanup.ts";

const [stateDir, acpDir, id] = process.argv.slice(2);
if (!stateDir || !acpDir || !id) throw new Error("Usage: cleanup-peer-acquire.ts STATE_DIR ACP_DIR SESSION_ID");
try {
  process.stdout.write(await new SessionCleanup(stateDir, acpDir).acquire(id, false, 987654, 0));
} catch (error) {
  process.stdout.write(typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "ERROR");
  process.exitCode = 1;
}
