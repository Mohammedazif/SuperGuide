export interface TextChunk {
  ordinal: number;
  content: string;
}

export interface ChunkOptions {
  targetCharacters?: number;
  overlapCharacters?: number;
  maximumChunks?: number;
}

function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

export function chunkDocument(text: string, options: ChunkOptions = {}): TextChunk[] {
  const target = options.targetCharacters ?? 1200;
  const overlap = options.overlapCharacters ?? 150;
  const maximum = options.maximumChunks ?? 2000;

  const chunks: TextChunk[] = [];
  let current = "";

  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed.length === 0) return;
    chunks.push({ ordinal: chunks.length, content: trimmed });
    current = overlap > 0 ? trimmed.slice(Math.max(0, trimmed.length - overlap)) : "";
  };

  for (const paragraph of paragraphs(text)) {
    if (paragraph.length > target) {
      flush();
      for (let start = 0; start < paragraph.length; start += target - overlap) {
        const slice = paragraph.slice(start, start + target).trim();
        if (slice.length === 0) continue;
        chunks.push({ ordinal: chunks.length, content: slice });
        if (chunks.length >= maximum) return chunks;
      }
      current = "";
      continue;
    }

    if (current.length + paragraph.length + 2 > target) flush();
    current = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
    if (chunks.length >= maximum) return chunks;
  }

  flush();
  return chunks.slice(0, maximum);
}
