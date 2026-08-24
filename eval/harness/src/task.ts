import { z } from "zod";

export const ladderLevelSchema = z.enum(["L1", "L2", "L3", "L4", "L5", "L6"]);

export const seedSchema = z
  .object({
    billing_address: z
      .object({
        line1: z.string(),
        line2: z.string().nullable(),
        city: z.string(),
        postal_code: z.string(),
        country: z.string(),
      })
      .optional(),
    plan: z.enum(["starter", "growth", "scale"]).optional(),
    registration_number: z.string().nullable().optional(),
    sso_enabled: z.boolean().optional(),
    enforced_domain: z.string().nullable().optional(),
  })
  .default({});

export const predicateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("api_json_path"),
    path: z.string(),
    equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
  z.object({ kind: z.literal("state_unchanged") }),
  z.object({
    kind: z.literal("seat_status"),
    seatId: z.string(),
    status: z.enum(["active", "invited", "removed"]),
  }),
  z.object({ kind: z.literal("message_contains"), text: z.string() }),
]);

export const recordedTurnSchema = z.object({
  tool: z.string(),
  input: z.record(z.string(), z.unknown()).default({}),
  text: z.string().optional(),
});

export const browserReplySchema = z.object({
  status: z.enum(["ok", "failed"]).default("ok"),
  errorCode: z.string().optional(),
  data: z.unknown().optional(),
  url: z.string().optional(),
});

export const evalTaskSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  version: z.int().positive(),
  title: z.string().min(1),
  message: z.string().min(1),
  startPath: z.string().default("/account"),
  identity: z
    .object({
      tier: z.enum(["anonymous", "unverified", "verified"]).default("verified"),
      scopes: z.array(z.string()).default([]),
      role: z.string().default("owner"),
    })
    .default({ tier: "verified", scopes: [], role: "owner" }),
  seed: seedSchema,
  procedure: z.string().optional(),
  capabilities: z
    .array(
      z.object({
        name: z.string(),
        risk: z.enum(["read", "write", "destructive", "financial", "communication"]),
        reply: browserReplySchema.default({ status: "ok" }),
      }),
    )
    .default([]),
  confirmations: z.enum(["approve", "deny", "ignore"]).default("approve"),
  groundedActions: z.boolean().default(false),
  stepBudget: z.int().positive().default(8),
  transcript: z.array(recordedTurnSchema).min(1),
  expect: z.object({
    resolution: z.enum(["resolved", "unresolved", "escalated", "in_progress", "cancelled"]),
    ladderLevel: ladderLevelSchema.nullable().default(null),
    maxSteps: z.int().positive().default(12),
    predicates: z.array(predicateSchema).min(1),
  }),
});

export type EvalTask = z.infer<typeof evalTaskSchema>;
export type EvalPredicate = z.infer<typeof predicateSchema>;
