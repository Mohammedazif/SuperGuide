import { z } from "zod";
import { isoTimestampSchema, uuidSchema } from "../public/primitives.js";

export const EMBEDDING_DIMENSIONS = 1536;

export const sourceKindSchema = z.enum(["upload", "crawl", "manual"]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const injectionVerdictSchema = z.enum(["clean", "suspicious", "malicious", "unclassified"]);
export type InjectionVerdict = z.infer<typeof injectionVerdictSchema>;

export const documentSchema = z.object({
  id: uuidSchema,
  productId: uuidSchema,
  sourceKind: sourceKindSchema,
  sourceUrl: z.string().nullable(),
  title: z.string(),
  contentHash: z.string().length(64),
  indexedAt: isoTimestampSchema.nullable(),
});
export type KnowledgeDocument = z.infer<typeof documentSchema>;

export const chunkSchema = z.object({
  id: uuidSchema,
  documentId: uuidSchema,
  productId: uuidSchema,
  ordinal: z.int().nonnegative(),
  content: z.string(),
  injectionVerdict: injectionVerdictSchema,
});
export type KnowledgeChunk = z.infer<typeof chunkSchema>;

export const retrievedChunkSchema = chunkSchema.extend({
  score: z.number(),
  documentTitle: z.string(),
  sourceUrl: z.string().nullable(),
});
export type RetrievedChunk = z.infer<typeof retrievedChunkSchema>;

export const PROVENANCE_SOURCES = ["knowledge_base", "api_response", "page_content"] as const;
export const provenanceSourceSchema = z.enum(PROVENANCE_SOURCES);
export type ProvenanceSource = z.infer<typeof provenanceSourceSchema>;

export const provenanceEnvelopeSchema = z.object({
  source: provenanceSourceSchema,
  reference: z.string(),
  content: z.string(),
});
export type ProvenanceEnvelope = z.infer<typeof provenanceEnvelopeSchema>;
