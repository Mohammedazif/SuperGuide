import { z } from "zod";

export const policyReasonSchema = z.enum([
  "unknown_action",
  "risk_class_blocked",
  "procedure_forbids",
  "identity_insufficient",
  "scope_missing",
  "escalation_condition",
  "procedure_confirm",
  "write_requires_confirmation",
]);
export type PolicyReason = z.infer<typeof policyReasonSchema>;

export const policyVerdictSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("allow") }),
  z.object({
    decision: z.literal("confirm"),
    reason: policyReasonSchema,
    preview: z.string().min(1),
  }),
  z.object({ decision: z.literal("block"), reason: policyReasonSchema }),
]);
export type PolicyVerdict = z.infer<typeof policyVerdictSchema>;

export const confirmationDecisionSchema = z.enum(["approved", "denied", "timeout"]);
export type ConfirmationDecision = z.infer<typeof confirmationDecisionSchema>;
