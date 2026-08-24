import { createHash } from "node:crypto";
import { EMBEDDING_DIMENSIONS } from "@superguide/contract/internal";

export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

function bucket(token: string, salt: string): { index: number; sign: number } {
  const digest = createHash("sha256").update(`${salt}:${token}`).digest();
  const index = digest.readUInt32BE(0) % EMBEDDING_DIMENSIONS;
  const sign = (digest[4] ?? 0) % 2 === 0 ? 1 : -1;
  return { index, sign };
}

// The locked stack names one model provider, and that provider has no embedding endpoint.
// This projection is deterministic, needs no network, and keeps retrieval testable. It is a
// placeholder for a real embedding service, and swapping one in replaces this class only.
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = EMBEDDING_DIMENSIONS;

  embed(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.#embedOne(text)));
  }

  #embedOne(text: string): number[] {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    const tokens = tokenise(text);

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === undefined) continue;

      const unigram = bucket(token, "1");
      vector[unigram.index] = (vector[unigram.index] ?? 0) + unigram.sign;

      const next = tokens[index + 1];
      if (next !== undefined) {
        const bigram = bucket(`${token} ${next}`, "2");
        vector[bigram.index] = (vector[bigram.index] ?? 0) + bigram.sign * 0.6;
      }
    }

    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm === 0) return vector;
    return vector.map((value) => value / norm);
  }
}

export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => value.toFixed(6)).join(",")}]`;
}
