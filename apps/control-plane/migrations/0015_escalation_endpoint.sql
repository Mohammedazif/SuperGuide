ALTER TABLE product ADD COLUMN escalation_webhook_url text;
ALTER TABLE product ADD COLUMN escalation_email text;

GRANT UPDATE (escalation_webhook_url, escalation_email) ON product TO sg_app;
