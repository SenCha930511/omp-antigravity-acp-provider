import type { AntigravityAcpErrorCode } from "../extension/runtime/acp/errors.ts";

type Assert<T extends true> = T;
type QuotaIsAnErrorCode = Assert<"quota" extends AntigravityAcpErrorCode ? true : false>;

export const quotaCode: AntigravityAcpErrorCode = "quota";
export type Contract = QuotaIsAnErrorCode;
