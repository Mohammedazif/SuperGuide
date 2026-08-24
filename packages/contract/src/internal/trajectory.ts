import { z } from "zod";
import { agentActionSchema } from "../public/action.js";
import { expectOutcomeSchema } from "../public/expect.js";
import { policyVerdictSchema } from "../public/policy.js";
import {
  isoTimestampSchema,
  ladderLevelSchema,
  resolutionStateSchema,
  seqSchema,
  uuidSchema,
} from "../public/primitives.js";

export const stepResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    data: z.json(),
    httpStatus: z.int().nullable(),
    url: z.string().nullable(),
  }),
  z.object({
    status: z.literal("failed"),
    code: z.string(),
    message: z.string(),
    httpStatus: z.int().nullable(),
    url: z.string().nullable(),
  }),
  z.object({ status: z.literal("not_executed"), code: z.string(), message: z.string() }),
]);
export type StepResult = z.infer<typeof stepResultSchema>;

export const trajectoryStepSchema = z.object({
  id: uuidSchema,
  conversationId: uuidSchema,
  productId: uuidSchema,
  turnId: uuidSchema,
  seq: seqSchema,
  ladderLevel: ladderLevelSchema,
  action: agentActionSchema,
  policyVerdict: policyVerdictSchema,
  result: stepResultSchema,
  expectOutcome: expectOutcomeSchema,
  model: z.string().nullable(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadTokens: z.int().nonnegative(),
  latencyMs: z.int().nonnegative(),
  requestId: z.string(),
  createdAt: isoTimestampSchema,
});
export type TrajectoryStep = z.infer<typeof trajectoryStepSchema>;

export const trajectorySchema = z.object({
  conversationId: uuidSchema,
  resolutionState: resolutionStateSchema,
  steps: z.array(trajectoryStepSchema),
});
export type Trajectory = z.infer<typeof trajectorySchema>;
