import { z } from "zod";
import {
  actionIdSchema,
  grantTierSchema,
  refusalReasonSchema,
  riskClassSchema,
  sha256HexSchema,
} from "./core.js";
import { actionSchema } from "./action.js";

export const confirmationSchema = z.strictObject({
  actionId: actionIdSchema,
  paramsHash: sha256HexSchema,
  approved: z.boolean(),
});
export type Confirmation = z.infer<typeof confirmationSchema>;

export const policyInputSchema = z.strictObject({
  actionId: actionIdSchema,
  action: actionSchema,
  paramsHash: sha256HexSchema,
  risk: riskClassSchema,
  adapterMatched: z.boolean(),
  siteActivated: z.boolean(),
  tier: grantTierSchema,
  writeConsent: z.boolean(),
  confirmation: confirmationSchema.nullable(),
});
export type PolicyInput = z.infer<typeof policyInputSchema>;

export const verdictSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("proceed") }),
  z.strictObject({ kind: z.literal("confirm"), summary: z.string().min(1) }),
  z.strictObject({ kind: z.literal("refuse"), reason: refusalReasonSchema }),
]);
export type Verdict = z.infer<typeof verdictSchema>;
