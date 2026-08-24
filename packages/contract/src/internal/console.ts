import { z } from "zod";
import { isoTimestampSchema, uuidSchema } from "../public/primitives.js";

export const procedureRecordSchema = z.object({
  id: uuidSchema,
  productId: uuidSchema,
  slug: z.string().min(1),
  version: z.int().positive(),
  body: z.json(),
  sourceYaml: z.string(),
  active: z.boolean(),
  createdAt: isoTimestampSchema,
  createdBy: z.string(),
});
export type ProcedureRecord = z.infer<typeof procedureRecordSchema>;

export const publishProcedureRequestSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9_]*$/),
  sourceYaml: z.string().min(1),
});
export type PublishProcedureRequest = z.infer<typeof publishProcedureRequestSchema>;

export const procedureValidationResultSchema = z.discriminatedUnion("valid", [
  z.object({ valid: z.literal(true), slug: z.string(), version: z.int() }),
  z.object({
    valid: z.literal(false),
    issues: z.array(z.object({ path: z.string(), message: z.string() })),
  }),
]);
export type ProcedureValidationResult = z.infer<typeof procedureValidationResultSchema>;

export const retentionPolicySchema = z.object({
  productId: uuidSchema,
  retentionDays: z.int().positive().max(3650),
});
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;

export const usageRecordSchema = z.object({
  productId: uuidSchema,
  periodStart: isoTimestampSchema,
  periodEnd: isoTimestampSchema,
  conversations: z.int().nonnegative(),
  verifiedResolutions: z.int().nonnegative(),
  escalations: z.int().nonnegative(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadTokens: z.int().nonnegative(),
});
export type UsageRecord = z.infer<typeof usageRecordSchema>;

export const consoleSessionSchema = z.object({
  operatorEmail: z.email(),
  tenantId: uuidSchema,
  expiresAt: isoTimestampSchema,
});
export type ConsoleSession = z.infer<typeof consoleSessionSchema>;
