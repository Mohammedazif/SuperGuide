-- The console authors procedures and reviews tools through the application role. Insert and
-- update are needed for that; delete stays revoked so authoring history is never destroyed.
GRANT INSERT, UPDATE ON procedure TO sg_app;
GRANT INSERT, UPDATE ON tool TO sg_app;
