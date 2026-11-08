export const TOOL_RELAY_CONTROL_NAME = "pi_omp_await_result";
export const TOOL_RELAY_PI_NAME = "omp_await_result";
export const TOOL_RELAY_VERSION = 1;

export function relayNotice(callId) {
  return [
    "Tool still running.",
    `Call ${TOOL_RELAY_CONTROL_NAME} with {"call_id":"${callId}"}.`,
    "Do not call the original tool again. Do not claim completion before the result arrives.",
  ].join("\n");
}

export function parseRelayCallId(text) {
  if (typeof text !== "string") return undefined;
  const json = text.match(/"call_id"\s*:\s*"([A-Za-z0-9_-]+)"/u);
  if (json?.[1]) return json[1];
  const plain = text.match(/call_id\s*[:=]\s*([A-Za-z0-9_-]+)/u);
  return plain?.[1];
}
