import { z } from "zod";

export const targetDescriptorSchema = z.strictObject({
  role: z.string().min(1),
  name: z.string().min(1),
});
export type TargetDescriptor = z.infer<typeof targetDescriptorSchema>;

export const expectPredicateSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("element-present"), target: targetDescriptorSchema }),
  z.strictObject({ kind: z.literal("element-absent"), target: targetDescriptorSchema }),
  z.strictObject({
    kind: z.literal("text-matches"),
    target: targetDescriptorSchema.nullable(),
    contains: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("url-matches"), contains: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("value-equals"),
    target: targetDescriptorSchema,
    value: z.string(),
  }),
  z.strictObject({
    kind: z.literal("state-is"),
    target: targetDescriptorSchema,
    state: z.enum(["checked", "unchecked", "disabled", "enabled", "expanded", "collapsed"]),
  }),
]);
export type ExpectPredicate = z.infer<typeof expectPredicateSchema>;
