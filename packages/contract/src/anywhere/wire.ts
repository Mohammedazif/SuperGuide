import { z } from "zod";
import {
  actionIdSchema,
  deviceIdSchema,
  grantTierSchema,
  originSchema,
  quotaSchema,
  sha256HexSchema,
  turnIdSchema,
} from "./core.js";
import { actionResultSchema } from "./action.js";
import { pageDigestSchema } from "./digest.js";
import { adapterSetSchema } from "./adapter.js";

export const deviceRegisterRequestSchema = z.strictObject({
  deviceId: deviceIdSchema,
});
export const deviceRegisterResponseSchema = z.strictObject({
  sessionToken: z.string().min(1),
  expiresAt: z.iso.datetime(),
});

export const taskRequestSchema = z.strictObject({
  origin: originSchema,
  url: z.url(),
  tier: grantTierSchema,
  taskText: z.string().min(1).max(4000),
  digest: pageDigestSchema,
  adapterSetVersion: z.number().int().min(1).nullable(),
});
export type TaskRequest = z.infer<typeof taskRequestSchema>;

export const taskResponseSchema = z.strictObject({
  turnId: turnIdSchema,
  quota: quotaSchema,
});

export const actionResultRequestSchema = z.strictObject({
  turnId: turnIdSchema,
  actionId: actionIdSchema,
  result: actionResultSchema,
  digest: pageDigestSchema.nullable(),
});

export const anywhereConfirmRequestSchema = z.strictObject({
  turnId: turnIdSchema,
  actionId: actionIdSchema,
  paramsHash: sha256HexSchema,
  approved: z.boolean(),
});

export const quotaResponseSchema = z.strictObject({
  quota: quotaSchema,
});

export const adaptersResponseSchema = adapterSetSchema;

export const anywhereErrorCodeSchema = z.enum([
  "bad_request",
  "unauthorized",
  "origin_rejected",
  "not_found",
  "quota_exhausted",
  "rate_limited",
  "internal",
]);
export type AnywhereErrorCode = z.infer<typeof anywhereErrorCodeSchema>;

export const anywhereErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: anywhereErrorCodeSchema,
    message: z.string().min(1),
    resetsAt: z.iso.datetime().optional(),
  }),
});
export type AnywhereErrorResponse = z.infer<typeof anywhereErrorResponseSchema>;
