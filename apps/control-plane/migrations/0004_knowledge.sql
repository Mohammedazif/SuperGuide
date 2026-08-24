CREATE TABLE document (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL REFERENCES product (id) ON DELETE CASCADE,
  source_kind  text NOT NULL CHECK (source_kind IN ('upload', 'crawl', 'manual')),
  source_url   text,
  title        text NOT NULL,
  content_hash text NOT NULL,
  indexed_at   timestamptz,
  UNIQUE (product_id, content_hash)
);

CREATE TABLE chunk (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       uuid NOT NULL REFERENCES document (id) ON DELETE CASCADE,
  product_id        uuid NOT NULL REFERENCES product (id) ON DELETE CASCADE,
  ordinal           integer NOT NULL CHECK (ordinal >= 0),
  content           text NOT NULL,
  embedding         vector(1536),
  injection_verdict text NOT NULL DEFAULT 'unclassified'
                    CHECK (injection_verdict IN ('clean', 'suspicious', 'malicious', 'unclassified')),
  UNIQUE (document_id, ordinal)
);

CREATE INDEX chunk_product_idx ON chunk (product_id);

CREATE INDEX chunk_embedding_idx
  ON chunk USING hnsw (embedding vector_cosine_ops);
