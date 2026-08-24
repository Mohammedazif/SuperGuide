import { z } from "zod";

export const apiErrorCodeSchema = z.enum([
  "origin_not_allowed",
  "session_invalid",
  "session_expired",
  "identity_rejected",
  "product_unknown",
  "conversation_unknown",
  "turn_unknown",
  "tool_call_unknown",
  "params_hash_mismatch",
  "payload_invalid",
  "rate_limited",
  "grounded_actions_disabled",
  "internal_error",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({
  error: z.object({ code: apiErrorCodeSchema, message: z.string() }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const clientErrorCodeSchema = z.enum([
  "STALE_REF",
  "ELEMENT_NOT_FOUND",
  "ELEMENT_DISABLED",
  "NAV_INTERRUPTED",
  "TIMEOUT",
  "SETTLE_TIMEOUT",
  "UNKNOWN_ACTION",
  "ROUTE_UNKNOWN",
  "NAVIGATE_UNAVAILABLE",
  "CAPABILITY_NOT_REGISTERED",
  "CAPABILITY_ARGS_INVALID",
  "CAPABILITY_THREW",
  "GROUNDED_ACTIONS_DISABLED",
]);
export type ClientErrorCode = z.infer<typeof clientErrorCodeSchema>;
