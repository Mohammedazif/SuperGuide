import { z } from "zod";

export const grantTierSchema = z.enum(["observe", "control"]);
export type GrantTier = z.infer<typeof grantTierSchema>;

export const anywhereRiskClassSchema = z.enum(["read", "write", "sensitive"]);
export type AnywhereRiskClass = z.infer<typeof anywhereRiskClassSchema>;
export const riskClassSchema = anywhereRiskClassSchema;
export type RiskClass = AnywhereRiskClass;

export const syntheticIdSchema = z.string().regex(/^e[0-9a-f]{8}$/);
export type SyntheticId = z.infer<typeof syntheticIdSchema>;

export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256Hex = z.infer<typeof sha256HexSchema>;

export const originSchema = z.url().refine((value) => new URL(value).origin === value, {
  message: "must be a canonical origin with no path, query, or trailing slash",
});
export type Origin = z.infer<typeof originSchema>;

export const hostSchema = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);
export type Host = z.infer<typeof hostSchema>;

export const turnIdSchema = z.uuid();
export const actionIdSchema = z.uuid();
export const deviceIdSchema = z.uuid();

export const refusalReasonSchema = z.enum([
  "grant_insufficient",
  "confirmation_mismatch",
  "declined_by_user",
  "site_not_activated",
  "quota_exhausted",
  "budget_exhausted",
  "model_refusal",
  "stopped_by_user",
]);
export type RefusalReason = z.infer<typeof refusalReasonSchema>;

export const quotaSchema = z.strictObject({
  used: z.number().int().min(0),
  limit: z.number().int().min(0),
  resetsAt: z.iso.datetime(),
});
export type Quota = z.infer<typeof quotaSchema>;
