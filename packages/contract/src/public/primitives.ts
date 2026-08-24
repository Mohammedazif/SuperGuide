import { z } from "zod";

export const uuidSchema = z.uuid();
export const isoTimestampSchema = z.iso.datetime({ offset: true });
export const seqSchema = z.int().nonnegative();

export const riskClassSchema = z.enum([
  "read",
  "write",
  "destructive",
  "financial",
  "communication",
]);
export type RiskClass = z.infer<typeof riskClassSchema>;

export const RISK_CLASS_ORDER: readonly RiskClass[] = [
  "read",
  "write",
  "communication",
  "financial",
  "destructive",
];

export const identityTierSchema = z.enum(["anonymous", "unverified", "verified"]);
export type IdentityTier = z.infer<typeof identityTierSchema>;

export const ladderLevelSchema = z.enum(["L1", "L2", "L3", "L4", "L5", "L6"]);
export type LadderLevel = z.infer<typeof ladderLevelSchema>;

export const conversationStatusSchema = z.enum(["open", "closed"]);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

export const resolutionStateSchema = z.enum([
  "in_progress",
  "resolved",
  "unresolved",
  "escalated",
  "cancelled",
]);
export type ResolutionState = z.infer<typeof resolutionStateSchema>;

export const messageRoleSchema = z.enum(["user", "assistant", "system"]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const identitySchema = z.object({
  tier: identityTierSchema,
  endUserId: uuidSchema,
  externalId: z.string().nullable(),
  scopes: z.array(z.string()).readonly(),
  claims: z.record(z.string(), z.unknown()),
});
export type Identity = z.infer<typeof identitySchema>;
