import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { SourceKind } from "@superguide/contract/internal";
import type { Transaction } from "../db/client.js";
import { chunk as chunkTable, document as documentTable } from "../db/schema.js";
import { chunkDocument } from "./chunk.js";
import type { EmbeddingProvider } from "./embedding.js";
import type { InjectionClassifier } from "./injection.js";

export interface IngestInput {
  productId: string;
  sourceKind: SourceKind;
  sourceUrl: string | null;
  title: string;
  text: string;
}

export interface IngestOutcome {
  documentId: string;
  chunks: number;
  clean: number;
  withheld: number;
  unchanged: boolean;
}

export interface IngestDependencies {
  embeddings: EmbeddingProvider;
  classifier: InjectionClassifier;
  signal: AbortSignal;
}

export async function ingestDocument(
  tx: Transaction,
  input: IngestInput,
  deps: IngestDependencies,
): Promise<IngestOutcome> {
  const contentHash = createHash("sha256").update(input.text).digest("hex");

  const existing = await tx
    .select()
    .from(documentTable)
    .where(
      and(eq(documentTable.productId, input.productId), eq(documentTable.contentHash, contentHash)),
    )
    .limit(1);

  const found = existing[0];
  if (found !== undefined && found.indexedAt !== null) {
    const counted = await tx
      .select()
      .from(chunkTable)
      .where(eq(chunkTable.documentId, found.id));
    return {
      documentId: found.id,
      chunks: counted.length,
      clean: counted.filter((row) => row.injectionVerdict === "clean").length,
      withheld: counted.filter((row) => row.injectionVerdict !== "clean").length,
      unchanged: true,
    };
  }

  const documentId =
    found?.id ??
    (
      await tx
        .insert(documentTable)
        .values({
          productId: input.productId,
          sourceKind: input.sourceKind,
          sourceUrl: input.sourceUrl,
          title: input.title,
          contentHash,
        })
        .returning()
    )[0]?.id;

  if (documentId === undefined) throw new Error("document insert returned no row");

  await tx.delete(chunkTable).where(eq(chunkTable.documentId, documentId));

  const pieces = chunkDocument(input.text);
  if (pieces.length === 0) {
    await tx
      .update(documentTable)
      .set({ indexedAt: new Date() })
      .where(eq(documentTable.id, documentId));
    return { documentId, chunks: 0, clean: 0, withheld: 0, unchanged: false };
  }

  const vectors = await deps.embeddings.embed(pieces.map((piece) => piece.content));

  let clean = 0;
  let withheld = 0;

  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    const vector = vectors[index];
    if (piece === undefined || vector === undefined) continue;

    const verdict = await deps.classifier.classify(piece.content, deps.signal);
    if (verdict === "clean") clean += 1;
    else withheld += 1;

    await tx.insert(chunkTable).values({
      documentId,
      productId: input.productId,
      ordinal: piece.ordinal,
      content: piece.content,
      embedding: vector,
      injectionVerdict: verdict,
    });
  }

  await tx
    .update(documentTable)
    .set({ indexedAt: new Date() })
    .where(eq(documentTable.id, documentId));

  return { documentId, chunks: pieces.length, clean, withheld, unchanged: false };
}
