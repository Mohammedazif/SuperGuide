-- Delete stays revoked so authoring history is never destroyed.
GRANT INSERT, UPDATE ON procedure TO sg_app;
GRANT INSERT, UPDATE ON tool TO sg_app;
