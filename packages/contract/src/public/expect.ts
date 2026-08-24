import { z } from "zod";

export const expectPredicateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("http_status"), in: z.array(z.int()).min(1) }),
  z.object({
    kind: z.literal("json_path"),
    path: z.string().min(1),
    equals: z.unknown().optional(),
    exists: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("url_matches"), pattern: z.string().min(1) }),
  z.object({ kind: z.literal("capability_status"), status: z.literal("ok") }),
  z.object({
    kind: z.literal("element_state"),
    role: z.string().min(1),
    nameContains: z.string().min(1),
  }),
]);
export type ExpectPredicate = z.infer<typeof expectPredicateSchema>;

export const expectOutcomeSchema = z.object({
  satisfied: z.boolean(),
  evaluatedBy: z.enum(["rules", "model"]),
  detail: z.string(),
});
export type ExpectOutcome = z.infer<typeof expectOutcomeSchema>;
