import { z } from "zod";
import { agentActionSchema } from "./action.js";
import { pageDigestSchema } from "./digest.js";
import { clientErrorCodeSchema } from "./errors.js";
import { confirmationDecisionSchema, policyVerdictSchema } from "./policy.js";
import {
  conversationStatusSchema,
  identityTierSchema,
  isoTimestampSchema,
  messageRoleSchema,
  resolutionStateSchema,
  seqSchema,
  uuidSchema,
} from "./primitives.js";

export const createSessionRequestSchema = z.object({ productId: uuidSchema });
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const sessionResponseSchema = z.object({
  sessionToken: z.string().min(1),
  expiresAt: isoTimestampSchema,
  tier: identityTierSchema,
  scopes: z.array(z.string()),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const identifyRequestSchema = z.object({ token: z.string().min(1) });
export type IdentifyRequest = z.infer<typeof identifyRequestSchema>;

export const routeDescriptorSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  template: z.string().min(1),
  params: z.array(z.string()),
  requiresScopes: z.array(z.string()),
});
export type RouteDescriptor = z.infer<typeof routeDescriptorSchema>;

export const productConfigSchema = z.object({
  productId: uuidSchema,
  name: z.string(),
  groundedActionsEnabled: z.boolean(),
  stepBudget: z.int().positive(),
  routes: z.array(routeDescriptorSchema),
  redactionAllowlist: z.array(z.string()),
});
export type ProductConfig = z.infer<typeof productConfigSchema>;

export const chatRequestSchema = z.object({
  conversationId: uuidSchema.nullable(),
  message: z.string().min(1).max(8000),
  digest: pageDigestSchema.nullable(),
  url: z.string().max(2048),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const chatAcceptedSchema = z.object({
  turnId: uuidSchema,
  conversationId: uuidSchema,
});
export type ChatAccepted = z.infer<typeof chatAcceptedSchema>;

export const toolResultPayloadSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    data: z.unknown(),
    digest: pageDigestSchema.nullable(),
    url: z.string().max(2048),
  }),
  z.object({
    status: z.literal("failed"),
    error: z.object({ code: clientErrorCodeSchema, message: z.string().max(1000) }),
    digest: pageDigestSchema.nullable(),
    url: z.string().max(2048),
  }),
]);
export type ToolResultPayload = z.infer<typeof toolResultPayloadSchema>;

export const toolResultRequestSchema = z.object({
  conversationId: uuidSchema,
  toolCallId: z.string().min(1).max(128),
  result: toolResultPayloadSchema,
});
export type ToolResultRequest = z.infer<typeof toolResultRequestSchema>;

export const toolResultAcceptedSchema = z.object({
  status: z.enum(["accepted", "duplicate", "unknown_call"]),
});
export type ToolResultAccepted = z.infer<typeof toolResultAcceptedSchema>;

export const confirmRequestSchema = z.object({
  conversationId: uuidSchema,
  toolCallId: z.string().min(1).max(128),
  paramsHash: z.string().length(64),
  decision: confirmationDecisionSchema,
});
export type ConfirmRequest = z.infer<typeof confirmRequestSchema>;

export const conversationSummarySchema = z.object({
  id: uuidSchema,
  status: conversationStatusSchema,
  resolutionState: resolutionStateSchema,
  createdAt: isoTimestampSchema,
  closedAt: isoTimestampSchema.nullable(),
  lastMessagePreview: z.string(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationListSchema = z.object({
  conversations: z.array(conversationSummarySchema),
});
export type ConversationList = z.infer<typeof conversationListSchema>;

export const messageContentSchema = z.object({ text: z.string() });

export const durableMessageSchema = z.object({
  id: uuidSchema,
  seq: seqSchema,
  role: messageRoleSchema,
  content: messageContentSchema,
  createdAt: isoTimestampSchema,
});
export type DurableMessage = z.infer<typeof durableMessageSchema>;

export const durableStepSchema = z.object({
  id: uuidSchema,
  seq: seqSchema,
  turnId: uuidSchema,
  action: agentActionSchema,
  policyVerdict: policyVerdictSchema,
  expectOutcome: z.object({
    satisfied: z.boolean(),
    evaluatedBy: z.enum(["rules", "model"]),
    detail: z.string(),
  }),
  createdAt: isoTimestampSchema,
});
export type DurableStep = z.infer<typeof durableStepSchema>;
