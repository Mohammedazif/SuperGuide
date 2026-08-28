import { z } from "zod";

export const deviceTokenClaimsSchema = z.strictObject({
  deviceId: z.uuid(),
  issuedAt: z.number().int().min(0),
  expiresAt: z.number().int().min(0),
});
export type DeviceTokenClaims = z.infer<typeof deviceTokenClaimsSchema>;

export const anywhereTrajectoryStepKindSchema = z.enum([
  "task-received",
  "model-response",
  "injection-scan",
  "action-planned",
  "policy-verdict",
  "action-dispatched",
  "action-result",
  "confirmation",
  "observation",
  "question",
  "report",
  "refusal",
  "error",
  "turn-end",
]);
export type AnywhereTrajectoryStepKind = z.infer<typeof anywhereTrajectoryStepKindSchema>;
