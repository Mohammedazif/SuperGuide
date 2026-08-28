import { sql } from "drizzle-orm";
import type { RetrievedChunk } from "@superguide/contract/internal";
import { withProduct, type Database } from "../db/client.js";
import type { KnowledgeRetriever } from "../turn/loop.js";
import { toVectorLiteral, type EmbeddingProvider } from "./embedding.js";
import type { AppLogger } from "../logging.js";

interface CandidateRow extends Record<string, unknown> {
  id: string;
  document_id: string;
  product_id: string;
  ordinal: number;
  content: string;
  injection_verdict: string;
  distance: string | number;
  title: string;
  source_url: string | null;
}

function lexicalOverlap(query: string, content: string): number {
  const needles = new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2),
  );
  if (needles.size === 0) return 0;

  const haystack = new Set(
    content
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2),
  );

  let hits = 0;
  for (const needle of needles) if (haystack.has(needle)) hits += 1;
  return hits / needles.size;
}

export interface PgVectorRetrieverOptions {
  db: Database;
  embeddings: EmbeddingProvider;
  logger: AppLogger;
  candidateCount?: number;
  resultCount?: number;
}

export class PgVectorRetriever implements KnowledgeRetriever {
  readonly #options: PgVectorRetrieverOptions;

  constructor(options: PgVectorRetrieverOptions) {
    this.#options = options;
  }

  async retrieve(productId: string, query: string, _signal: AbortSignal): Promise<RetrievedChunk[]> {
    if (query.trim().length === 0) return [];

    const candidateCount = this.#options.candidateCount ?? 24;
    const resultCount = this.#options.resultCount ?? 5;

    let vector: string;
    try {
      const embedded = await this.#options.embeddings.embed([query]);
      const first = embedded[0];
      if (first === undefined) return [];
      vector = toVectorLiteral(first);
    } catch (error) {
      this.#options.logger.warn({ err: error }, "the query could not be embedded");
      return [];
    }

    let rows: CandidateRow[];
    try {
      // Only index-time clean fragments; unclassified stays out of context, not retrieved on doubt.
      const result = await withProduct(this.#options.db, productId, (tx) =>
        tx.execute<CandidateRow>(sql`
          SELECT c.id, c.document_id, c.product_id, c.ordinal, c.content, c.injection_verdict,
                 (c.embedding <=> ${vector}::vector) AS distance,
                 d.title, d.source_url
            FROM chunk c
            JOIN document d ON d.id = c.document_id
           WHERE c.injection_verdict = 'clean'
             AND c.embedding IS NOT NULL
           ORDER BY c.embedding <=> ${vector}::vector
           LIMIT ${candidateCount}
        `),
      );
      rows = result.rows;
    } catch (error) {
      this.#options.logger.error({ err: error }, "retrieval failed");
      return [];
    }

    return rows
      .map((row) => {
        const similarity = 1 - Number(row.distance);
        const lexical = lexicalOverlap(query, row.content);
        return {
          chunk: {
            id: row.id,
            documentId: row.document_id,
            productId: row.product_id,
            ordinal: row.ordinal,
            content: row.content,
            injectionVerdict: "clean" as const,
            score: 0.6 * similarity + 0.4 * lexical,
            documentTitle: row.title,
            sourceUrl: row.source_url,
          },
          rank: 0.6 * similarity + 0.4 * lexical,
        };
      })
      .sort((left, right) => right.rank - left.rank)
      .slice(0, resultCount)
      .map((entry) => entry.chunk satisfies RetrievedChunk);
  }
}
