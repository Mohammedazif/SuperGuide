import { z } from "zod";
import { refSchema } from "./action.js";

export const digestElementSchema = z.object({
  ref: refSchema,
  role: z.string(),
  name: z.string(),
  state: z
    .object({
      checked: z.boolean().optional(),
      expanded: z.boolean().optional(),
      selected: z.boolean().optional(),
      disabled: z.boolean().optional(),
    })
    .optional(),
  value: z.string().optional(),
  inViewport: z.boolean(),
});
export type DigestElement = z.infer<typeof digestElementSchema>;

export const pageDigestSchema = z.object({
  url: z.string(),
  title: z.string(),
  headings: z.array(z.string()),
  landmarks: z.array(z.string()),
  elements: z.array(digestElementSchema),
  truncated: z.boolean(),
});
export type PageDigest = z.infer<typeof pageDigestSchema>;

export const digestDiffSchema = z.object({
  url: z.string().nullable(),
  title: z.string().nullable(),
  added: z.array(digestElementSchema),
  removed: z.array(refSchema),
  changed: z.array(digestElementSchema),
  truncated: z.boolean(),
});
export type DigestDiff = z.infer<typeof digestDiffSchema>;
