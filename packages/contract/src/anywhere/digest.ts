import { z } from "zod";
import { syntheticIdSchema } from "./core.js";

export const digestNodeStateSchema = z.strictObject({
  disabled: z.boolean(),
  checked: z.boolean().optional(),
  expanded: z.boolean().optional(),
  required: z.boolean().optional(),
  invalid: z.boolean().optional(),
});
export type DigestNodeState = z.infer<typeof digestNodeStateSchema>;

export const digestNodeSchema = z.strictObject({
  id: syntheticIdSchema,
  parentId: syntheticIdSchema.nullable(),
  role: z.string().min(1),
  name: z.string(),
  value: z.string().optional(),
  state: digestNodeStateSchema,
  headingLevel: z.number().int().min(1).max(6).optional(),
  landmark: z.string().optional(),
  inViewport: z.boolean(),
  crossOriginFrame: z.boolean().optional(),
});
export type DigestNode = z.infer<typeof digestNodeSchema>;

export const pageDigestSchema = z.strictObject({
  url: z.url(),
  title: z.string(),
  nodes: z.array(digestNodeSchema).max(5000),
});
export type PageDigest = z.infer<typeof pageDigestSchema>;

export const digestDeltaSchema = z.strictObject({
  added: z.array(digestNodeSchema),
  removed: z.array(syntheticIdSchema),
  changed: z.array(digestNodeSchema),
  urlChanged: z.strictObject({ from: z.url(), to: z.url() }).nullable(),
  titleChanged: z.strictObject({ from: z.string(), to: z.string() }).nullable(),
});
export type DigestDelta = z.infer<typeof digestDeltaSchema>;
