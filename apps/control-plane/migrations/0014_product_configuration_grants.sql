-- Column grants omit id, tenant_id, deleted_at; sg_app cannot change identity or tenancy.
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
