-- A pooled connection resets sg.product_id to the empty string after SET LOCAL commits,
-- and ''::uuid raises rather than yielding NULL. NULLIF restores the intended property:
-- a connection that has not scoped itself sees nothing instead of erroring.
CREATE FUNCTION sg_current_product_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('sg.product_id', true), '')::uuid;
$$;

GRANT EXECUTE ON FUNCTION sg_current_product_id() TO sg_app;

DROP POLICY tenant_tenant_isolation ON tenant;
CREATE POLICY tenant_tenant_isolation ON tenant
  USING (id = (SELECT p.tenant_id FROM product p WHERE p.id = sg_current_product_id()));

DROP POLICY product_tenant_isolation ON product;
CREATE POLICY product_tenant_isolation ON product
  USING (id = sg_current_product_id())
  WITH CHECK (id = sg_current_product_id());

DROP POLICY product_secret_tenant_isolation ON product_secret;
CREATE POLICY product_secret_tenant_isolation ON product_secret
  USING (product_id = sg_current_product_id())
  WITH CHECK (product_id = sg_current_product_id());

DROP POLICY procedure_tenant_isolation ON procedure;
CREATE POLICY procedure_tenant_isolation ON procedure
  USING (product_id = sg_current_product_id())
  WITH CHECK (product_id = sg_current_product_id());

DROP POLICY tool_tenant_isolation ON tool;
CREATE POLICY tool_tenant_isolation ON tool
  USING (product_id = sg_current_product_id())
  WITH CHECK (product_id = sg_current_product_id());

DROP POLICY document_tenant_isolation ON document;
CREATE POLICY document_tenant_isolation ON document
  USING (product_id = sg_current_product_id())
  WITH CHECK (product_id = sg_current_product_id());

DROP POLICY chunk_tenant_isolation ON chunk;
CREATE POLICY chunk_tenant_isolation ON chunk
  USING (product_id = sg_current_product_id())
  WITH CHECK (product_id = sg_current_product_id());

DROP POLICY end_user_tenant_isolation ON end_user;
CREATE POLICY end_user_tenant_isolation ON end_user
  USING (product_id = sg_current_product_id())
  WITH CHECK (product_id = sg_current_product_id());

DROP POLICY conversation_tenant_isolation ON conversation;
CREATE POLICY conversation_tenant_isolation ON conversation
  USING (product_id = sg_current_product_id())
  WITH CHECK (product_id = sg_current_product_id());

DROP POLICY message_tenant_isolation ON message;
CREATE POLICY message_tenant_isolation ON message
  USING (product_id = sg_current_product_id())
  WITH CHECK (product_id = sg_current_product_id());

DROP POLICY step_tenant_isolation ON step;
CREATE POLICY step_tenant_isolation ON step
  USING (product_id = sg_current_product_id())
  WITH CHECK (product_id = sg_current_product_id());
