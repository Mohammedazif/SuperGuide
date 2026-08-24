CREATE FUNCTION sg_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'step is append-only';
END;
$$;

CREATE TRIGGER step_append_only
  BEFORE UPDATE OR DELETE ON step
  FOR EACH ROW EXECUTE FUNCTION sg_reject_mutation();

REVOKE UPDATE, DELETE ON step FROM sg_app;
