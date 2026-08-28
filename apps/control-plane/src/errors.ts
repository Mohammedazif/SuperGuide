import type { ApiErrorCode } from "@superguide/contract/public";
import { concealClientText } from "./conceal-client-text.js";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  origin_not_allowed: 403,
  session_invalid: 401,
  session_expired: 401,
  identity_rejected: 401,
  product_unknown: 404,
  conversation_unknown: 404,
  turn_unknown: 404,
  tool_call_unknown: 409,
  params_hash_mismatch: 409,
  payload_invalid: 400,
  rate_limited: 429,
  grounded_actions_disabled: 409,
  not_found: 404,
  internal_error: 500,
};

const PUBLIC_MESSAGE: Record<ApiErrorCode, string> = {
  origin_not_allowed: "Origin is not allowed for this product.",
  session_invalid: "Session token is not valid.",
  session_expired: "Session token has expired.",
  identity_rejected: "Identity token was rejected.",
  product_unknown: "Product not found.",
  conversation_unknown: "Conversation not found.",
  turn_unknown: "Turn not found.",
  tool_call_unknown: "No in-flight call with that identifier.",
  params_hash_mismatch: "Confirmation does not match the proposed action.",
  payload_invalid: "Request body failed validation.",
  rate_limited: "Too many requests.",
  grounded_actions_disabled: "Grounded actions are disabled for this product.",
  not_found: "Not found.",
  internal_error: "Internal error.",
};

export class ApiFailure extends Error {
  override readonly name = "ApiFailure";
  readonly code: ApiErrorCode;
  readonly httpStatus: number;
  readonly detail: string | undefined;

  constructor(code: ApiErrorCode, detail?: string) {
    super(PUBLIC_MESSAGE[code]);
    this.code = code;
    this.httpStatus = STATUS_BY_CODE[code];
    this.detail = detail;
  }

  toBody(): { error: { code: ApiErrorCode; message: string } } {
    return { error: { code: this.code, message: PUBLIC_MESSAGE[this.code] } };
  }
}

export class TurnFailure extends Error {
  override readonly name = "TurnFailure";
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

// Logs only: never put this cause chain on a browser-readable payload.
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    return cause === undefined ? error.message : `${error.message}: ${describeError(cause)}`;
  }
  return String(error);
}

const GENERIC_FAILURE_MESSAGE = "The turn could not be completed.";

// Publish-safe: TurnFailure only; never walk causes (provider bodies stay off the wire).
export function publicFailureMessage(error: unknown): string {
  const raw = error instanceof TurnFailure ? error.message : GENERIC_FAILURE_MESSAGE;
  return concealClientText(raw, GENERIC_FAILURE_MESSAGE);
}
