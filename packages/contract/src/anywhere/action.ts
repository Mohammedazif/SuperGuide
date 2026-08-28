import { z } from "zod";
import { syntheticIdSchema } from "./core.js";
import { digestDeltaSchema } from "./digest.js";
import { expectPredicateSchema } from "./predicate.js";

const targetSchema = z.strictObject({ id: syntheticIdSchema });

export const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("click"), target: targetSchema }),
  z.strictObject({ kind: z.literal("type"), target: targetSchema, value: z.string().max(4000) }),
  z.strictObject({
    kind: z.literal("select"),
    target: targetSchema,
    optionLabel: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("check"), target: targetSchema, checked: z.boolean() }),
  z.strictObject({ kind: z.literal("focus"), target: targetSchema }),
  z.strictObject({ kind: z.literal("scrollIntoView"), target: targetSchema }),
  z.strictObject({ kind: z.literal("navigate"), path: z.string().startsWith("/").max(2000) }),
  z.strictObject({
    kind: z.literal("waitFor"),
    predicate: expectPredicateSchema,
    timeoutMs: z.number().int().min(100).max(30_000),
  }),
  z.strictObject({ kind: z.literal("readBack"), target: targetSchema }),
]);
export type AgentAction = z.infer<typeof actionSchema>;
export type ActionKind = AgentAction["kind"];

export const OBSERVE_PERMITTED_ACTIONS: ReadonlySet<ActionKind> = new Set(["waitFor", "readBack"]);

export function isPermittedUnderObserve(kind: ActionKind): boolean {
  return OBSERVE_PERMITTED_ACTIONS.has(kind);
}

export const actionResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("completed"),
    delta: digestDeltaSchema,
    readBack: z.string().optional(),
  }),
  z.strictObject({
    status: z.literal("failed"),
    error: z.string().min(1),
    delta: digestDeltaSchema.nullable(),
  }),
  z.strictObject({
    status: z.literal("refused"),
    reason: z.enum(["grant_insufficient", "password_field", "stale_target", "unknown_action"]),
    detail: z.string(),
  }),
]);
export type ActionResult = z.infer<typeof actionResultSchema>;
