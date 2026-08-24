GRANT USAGE ON SCHEMA public TO sg_app;

GRANT SELECT ON tenant, product, product_secret, procedure, tool TO sg_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON document, chunk TO sg_app;
GRANT SELECT, INSERT, UPDATE ON end_user, conversation TO sg_app;
GRANT SELECT, INSERT ON message, step TO sg_app;

ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_tenant_isolation ON tenant
  USING (id = (SELECT p.tenant_id FROM product p
               WHERE p.id = current_setting('sg.product_id', true)::uuid));

ALTER TABLE product ENABLE ROW LEVEL SECURITY;
ALTER TABLE product FORCE ROW LEVEL SECURITY;
CREATE POLICY product_tenant_isolation ON product
  USING (id = current_setting('sg.product_id', true)::uuid)
  WITH CHECK (id = current_setting('sg.product_id', true)::uuid);

ALTER TABLE product_secret ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_secret FORCE ROW LEVEL SECURITY;
CREATE POLICY product_secret_tenant_isolation ON product_secret
  USING (product_id = current_setting('sg.product_id', true)::uuid)
  WITH CHECK (product_id = current_setting('sg.product_id', true)::uuid);

ALTER TABLE procedure ENABLE ROW LEVEL SECURITY;
ALTER TABLE procedure FORCE ROW LEVEL SECURITY;
CREATE POLICY procedure_tenant_isolation ON procedure
  USING (product_id = current_setting('sg.product_id', true)::uuid)
  WITH CHECK (product_id = current_setting('sg.product_id', true)::uuid);

ALTER TABLE tool ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool FORCE ROW LEVEL SECURITY;
CREATE POLICY tool_tenant_isolation ON tool
  USING (product_id = current_setting('sg.product_id', true)::uuid)
  WITH CHECK (product_id = current_setting('sg.product_id', true)::uuid);

ALTER TABLE document ENABLE ROW LEVEL SECURITY;
ALTER TABLE document FORCE ROW LEVEL SECURITY;
CREATE POLICY document_tenant_isolation ON document
  USING (product_id = current_setting('sg.product_id', true)::uuid)
  WITH CHECK (product_id = current_setting('sg.product_id', true)::uuid);

ALTER TABLE chunk ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunk FORCE ROW LEVEL SECURITY;
CREATE POLICY chunk_tenant_isolation ON chunk
  USING (product_id = current_setting('sg.product_id', true)::uuid)
  WITH CHECK (product_id = current_setting('sg.product_id', true)::uuid);

ALTER TABLE end_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE end_user FORCE ROW LEVEL SECURITY;
CREATE POLICY end_user_tenant_isolation ON end_user
  USING (product_id = current_setting('sg.product_id', true)::uuid)
  WITH CHECK (product_id = current_setting('sg.product_id', true)::uuid);

ALTER TABLE conversation ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_tenant_isolation ON conversation
  USING (product_id = current_setting('sg.product_id', true)::uuid)
  WITH CHECK (product_id = current_setting('sg.product_id', true)::uuid);

ALTER TABLE message ENABLE ROW LEVEL SECURITY;
ALTER TABLE message FORCE ROW LEVEL SECURITY;
CREATE POLICY message_tenant_isolation ON message
  USING (product_id = current_setting('sg.product_id', true)::uuid)
  WITH CHECK (product_id = current_setting('sg.product_id', true)::uuid);

ALTER TABLE step ENABLE ROW LEVEL SECURITY;
ALTER TABLE step FORCE ROW LEVEL SECURITY;
CREATE POLICY step_tenant_isolation ON step
  USING (product_id = current_setting('sg.product_id', true)::uuid)
  WITH CHECK (product_id = current_setting('sg.product_id', true)::uuid);
