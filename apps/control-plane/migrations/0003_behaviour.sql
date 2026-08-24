CREATE TABLE procedure (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES product (id) ON DELETE CASCADE,
  slug        text NOT NULL,
  version     integer NOT NULL CHECK (version > 0),
  body        jsonb NOT NULL,
  source_yaml text NOT NULL,
  active      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL,
  UNIQUE (product_id, slug, version)
);

CREATE UNIQUE INDEX procedure_one_active_version_idx
  ON procedure (product_id, slug)
  WHERE active;

CREATE TABLE tool (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      uuid NOT NULL REFERENCES product (id) ON DELETE CASCADE,
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('api', 'capability', 'route')),
  risk_class      text NOT NULL
                  CHECK (risk_class IN ('read', 'write', 'destructive', 'financial', 'communication')),
  definition      jsonb NOT NULL,
  expect_template jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled         boolean NOT NULL DEFAULT false,
  UNIQUE (product_id, name)
);

CREATE INDEX tool_product_enabled_idx ON tool (product_id) WHERE enabled;
