import { z } from "zod";
import { actionIdSchema, quotaSchema, refusalReasonSchema, anywhereRiskClassSchema, sha256HexSchema } from "./core.js";
import { actionSchema } from "./action.js";
import { expectPredicateSchema } from "./predicate.js";

const seq = z.number().int().min(0);

export const turnOutcomeSchema = z.enum(["completed", "not-completed"]);
export type TurnOutcome = z.infer<typeof turnOutcomeSchema>;

export const turnEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("assistant-text"), seq, text: z.string() }),
  z.strictObject({
    kind: z.literal("action-request"),
    seq,
    actionId: actionIdSchema,
    action: actionSchema,
    risk: anywhereRiskClassSchema,
    expect: z.array(expectPredicateSchema),
    paramsHash: sha256HexSchema,
    needsConfirmation: z.boolean(),
    summary: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("question"), seq, text: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("report"),
    seq,
    outcome: turnOutcomeSchema,
    detail: z.string().min(1),
    failedPredicate: expectPredicateSchema.nullable(),
    lastVerifiedState: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("refusal"),
    seq,
    reason: refusalReasonSchema,
    detail: z.string(),
  }),
  z.strictObject({ kind: z.literal("quota"), seq, quota: quotaSchema }),
  z.strictObject({
    kind: z.literal("turn-end"),
    seq,
    status: z.enum(["completed", "failed", "refused", "stopped", "needs-input"]),
  }),
]);
export type TurnEvent = z.infer<typeof turnEventSchema>;
