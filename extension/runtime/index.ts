// Public runtime surface of the OMP adapter. The build bundles this module into
// extension/runtime.mjs, which is the only runtime import the OMP-facing
// extension may reach at load time (OMP's marketplace launcher cannot resolve
// bare package specifiers inside that dynamic-import subgraph).
export { createAntigravityProvider } from "./provider.ts";
export { AntigravityRuntime, PERMISSION_TOOL_NAME, PERMISSION_RESULT_KIND, authenticateForCredential } from "./runtime.ts";
export { MANAGED_AUTH_MARKER, usableApiKey } from "./constants.ts";
export { loadConfig, savePermissionMode } from "./config.ts";
export {
  inspectAntigravityAuth,
  hasAntigravityAuth,
  clearAntigravityCredentials,
  resolveAntigravityAcpDirectory,
} from "./acp/antigravity.ts";
export { describeCredentialStorage } from "./acp/credential-storage.ts";
export { FALLBACK_MODELS, projectModels } from "./models.ts";
export { AcpSessionStore } from "../session-store.ts";
export { ensureAntigravityAcpReady, ensureManagedRuntime, prepareManagedRuntime } from "./managed.ts";
export { planToolProjection } from "./tools/bridge.ts";
export { PiEventWriter } from "./stream/pi-events.ts";
export { TierConnection } from "../tier-connection.ts";
export { SessionCleanup } from "../session-cleanup.ts";
export { Type } from "typebox";
