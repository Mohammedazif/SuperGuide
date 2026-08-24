import { z } from "zod";
import { isoTimestampSchema, uuidSchema } from "../public/primitives.js";
import { trajectoryStepSchema } from "./trajectory.js";

export const escalationReasonSchema = z.enum([
  "policy_block",
  "confirmation_denied",
  "confirmation_timeout",
  "expect_unsatisfied",
  "step_budget_exhausted",
  "process_restart",
  "model_unavailable",
  "user_requested",
]);
export type EscalationReason = z.infer<typeof escalationReasonSchema>;

export const escalationPayloadSchema = z.object({
  escalationId: uuidSchema,
  productId: uuidSchema,
  conversationId: uuidSchema,
  turnId: uuidSchema,
  reason: escalationReasonSchema,
  detail: z.string(),
  createdAt: isoTimestampSchema,
  endUser: z.object({
    id: uuidSchema,
    externalId: z.string().nullable(),
    tier: z.string(),
  }),
  transcript: z.array(z.object({ role: z.string(), text: z.string() })),
  trajectory: z.array(trajectoryStepSchema),
  knownTrue: z.array(z.string()),
  failurePoint: z
    .object({ stepSeq: z.int(), detail: z.string() })
    .nullable(),
  trajectoryUrl: z.string(),
});
export type EscalationPayload = z.infer<typeof escalationPayloadSchema>;

export const escalationDeliverySchema = z.object({
  id: uuidSchema,
  status: z.enum(["pending", "delivered", "dead_letter"]),
  attempts: z.int().nonnegative(),
  lastError: z.string().nullable(),
});
export type EscalationDelivery = z.infer<typeof escalationDeliverySchema>;
