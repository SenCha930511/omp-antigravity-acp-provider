export declare const TOOL_RELAY_CONTROL_NAME = "omp_await_result";
export declare const TOOL_RELAY_PI_NAME = "await_result";
export declare const TOOL_RELAY_VERSION = 1;
export declare function relayNotice(callId: string): string;
export declare function parseRelayCallId(text: unknown): string | undefined;
