-- The console configures a product. Column grants keep that narrow: identity, tenancy, and
-- the soft-delete marker stay outside what the application role can change.
GRANT UPDATE (
  name,
  origin_allowlist,
  jwks_url,
  jwt_issuer,
  jwt_audience,
  jwt_algorithms,
  route_registry,
  redaction_allowlist,
  grounded_actions_enabled,
  retention_days,
  api_base_url
) ON product TO sg_app;

GRANT INSERT, UPDATE ON product_secret TO sg_app;
