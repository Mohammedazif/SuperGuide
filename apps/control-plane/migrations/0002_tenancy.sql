CREATE TABLE tenant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TABLE product (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenant (id),
  name                      text NOT NULL,
  origin_allowlist          text[] NOT NULL DEFAULT '{}',
  jwks_url                  text,
  jwt_issuer                text,
  jwt_audience              text,
  jwt_algorithms            text[] NOT NULL DEFAULT '{RS256}',
  route_registry            jsonb NOT NULL DEFAULT '{"routes": []}'::jsonb,
  redaction_allowlist       jsonb NOT NULL DEFAULT '{"fieldNames": []}'::jsonb,
  grounded_actions_enabled  boolean NOT NULL DEFAULT false,
  retention_days            integer NOT NULL DEFAULT 90 CHECK (retention_days > 0),
  api_base_url              text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  deleted_at                timestamptz
);

CREATE INDEX product_tenant_idx ON product (tenant_id);

CREATE TABLE product_secret (
  product_id                 uuid PRIMARY KEY REFERENCES product (id) ON DELETE CASCADE,
  api_credentials_ciphertext bytea,
  api_credentials_iv         bytea,
  signing_public_key         text,
  rotated_at                 timestamptz,
  CONSTRAINT product_secret_ciphertext_pairs_with_iv
    CHECK ((api_credentials_ciphertext IS NULL) = (api_credentials_iv IS NULL))
);
