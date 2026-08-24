import { z } from "zod";
import { expectPredicateSchema } from "@superguide/contract/public";

export const procedureSlugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "a procedure id is lowercase letters, digits, and underscores");

export const preferApiStepSchema = z.object({
  operation: z.string().min(1),
  params: z.record(z.string(), z.string()).default({}),
});

export const elseUiStepSchema = z.object({
  goal: z.string().min(1),
  route: z.string().min(1).optional(),
  confirm_before: z.array(z.string()).default([]),
});

export const procedureStepSchema = z
  .object({
    prefer_api: preferApiStepSchema.optional(),
    else_ui: elseUiStepSchema.optional(),
  })
  .refine(
    (step) => step.prefer_api !== undefined || step.else_ui !== undefined,
    "a step must declare prefer_api, else_ui, or both",
  );

export const successPredicateSchema = z.union([
  z.object({
    api: z.object({
      operation: z.string().min(1),
      params: z.record(z.string(), z.string()).default({}),
      json_path: z.string().min(1),
      equals: z.unknown().optional(),
      exists: z.boolean().optional(),
    }),
  }),
  z.object({ predicate: expectPredicateSchema }),
]);

export const procedurePolicySchema = z.object({
  never: z.array(z.string()).default([]),
  confirm: z.array(z.string()).default([]),
  escalate_if: z.array(z.string()).default([]),
});

export const procedureDocumentSchema = z.object({
  id: procedureSlugSchema,
  version: z.int().positive(),
  title: z.string().min(1),
  when: z.string().min(1),
  preconditions: z.array(z.string()).default([]),
  required_scopes: z.array(z.string()).default([]),
  steps: z.array(procedureStepSchema).min(1),
  policy: procedurePolicySchema.default({ never: [], confirm: [], escalate_if: [] }),
  success: z.array(successPredicateSchema).default([]),
});

export type ProcedureDocument = z.infer<typeof procedureDocumentSchema>;
export type ProcedureStep = z.infer<typeof procedureStepSchema>;
export type SuccessPredicate = z.infer<typeof successPredicateSchema>;
