import { z } from "zod";
import { executorActionSchema } from "./action.js";
import { policyVerdictSchema } from "./policy.js";
import { durableMessageSchema, durableStepSchema } from "./wire.js";
import { isoTimestampSchema, ladderLevelSchema, resolutionStateSchema, seqSchema, uuidSchema } from "./primitives.js";

export const SG_EVENT_NAMES = [
  "turn.started",
  "turn.finished",
  "turn.failed",
  "message.delta",
  "message.completed",
  "step.recorded",
  "action.confirm",
  "action.executing",
  "action.result",
  "escalation.created",
] as const;

export const sgEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("turn.started"),
    turnId: uuidSchema,
    conversationId: uuidSchema,
    startedAt: isoTimestampSchema,
  }),
  z.object({
    event: z.literal("turn.finished"),
    turnId: uuidSchema,
    resolutionState: resolutionStateSchema,
    summary: z.string(),
  }),
  z.object({
    event: z.literal("turn.failed"),
    turnId: uuidSchema,
    code: z.string(),
    message: z.string(),
  }),
  z.object({ event: z.literal("message.delta"), turnId: uuidSchema, text: z.string() }),
  z.object({ event: z.literal("message.completed"), message: durableMessageSchema }),
  z.object({ event: z.literal("step.recorded"), step: durableStepSchema }),
  z.object({
    event: z.literal("action.confirm"),
    turnId: uuidSchema,
    toolCallId: z.string(),
    paramsHash: z.string().length(64),
    verdict: policyVerdictSchema,
    preview: z.string(),
    expiresAt: isoTimestampSchema,
  }),
  z.object({
    event: z.literal("action.executing"),
    turnId: uuidSchema,
    action: executorActionSchema,
    ladderLevel: ladderLevelSchema,
  }),
  z.object({
    event: z.literal("action.result"),
    turnId: uuidSchema,
    toolCallId: z.string(),
    satisfied: z.boolean(),
    detail: z.string(),
  }),
  z.object({
    event: z.literal("escalation.created"),
    turnId: uuidSchema,
    conversationId: uuidSchema,
    reason: z.string(),
    userMessage: z.string(),
    referenceUrl: z.string(),
  }),
]);
export type SgEvent = z.infer<typeof sgEventSchema>;
export type SgEventName = SgEvent["event"];

export const streamFrameSchema = z.object({
  id: seqSchema.nullable(),
  event: z.enum(SG_EVENT_NAMES),
  data: sgEventSchema,
});
export type StreamFrame = z.infer<typeof streamFrameSchema>;

export function isDurableEvent(name: SgEventName): boolean {
  switch (name) {
    case "message.completed":
    case "step.recorded":
      return true;
    case "turn.started":
    case "turn.finished":
    case "turn.failed":
    case "message.delta":
    case "action.confirm":
    case "action.executing":
    case "action.result":
    case "escalation.created":
      return false;
    default: {
      const exhaustive: never = name;
      throw new Error(`unhandled event: ${String(exhaustive)}`);
    }
  }
}
