-- Never ENABLE RLS: untenanted device surface, not an end_user; query outside withProduct().

CREATE TABLE device (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  quota_override integer
);

CREATE TABLE turn (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES device(id),
  origin text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('observe', 'control')),
  task_text text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'refused', 'stopped', 'needs-input')),
  counted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE INDEX turn_device_id_idx ON turn (device_id);

CREATE TABLE trajectory (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  turn_id uuid NOT NULL REFERENCES turn(id),
  seq integer NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (turn_id, seq)
);

CREATE FUNCTION trajectory_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('sga.allow_erasure', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'trajectory is append-only';
END;
$$;

CREATE TRIGGER trajectory_no_update_or_delete
  BEFORE UPDATE OR DELETE ON trajectory
  FOR EACH ROW EXECUTE FUNCTION trajectory_append_only();

CREATE TRIGGER trajectory_no_truncate
  BEFORE TRUNCATE ON trajectory
  FOR EACH STATEMENT EXECUTE FUNCTION trajectory_append_only();

CREATE TABLE turn_event (
  turn_id uuid NOT NULL REFERENCES turn(id),
  seq integer NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (turn_id, seq)
);

CREATE TRIGGER turn_event_no_update_or_delete
  BEFORE UPDATE OR DELETE ON turn_event
  FOR EACH ROW EXECUTE FUNCTION trajectory_append_only();

CREATE TRIGGER turn_event_no_truncate
  BEFORE TRUNCATE ON turn_event
  FOR EACH STATEMENT EXECUTE FUNCTION trajectory_append_only();

CREATE TABLE action_result (
  action_id uuid PRIMARY KEY,
  turn_id uuid NOT NULL REFERENCES turn(id),
  result jsonb NOT NULL,
  digest jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device_usage (
  device_id uuid NOT NULL REFERENCES device(id),
  day date NOT NULL,
  used integer NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, day)
);

CREATE TABLE ip_usage (
  ip_hash text NOT NULL,
  day date NOT NULL,
  used integer NOT NULL DEFAULT 0,
  registrations integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
);

CREATE TABLE confirmation (
  action_id uuid PRIMARY KEY,
  turn_id uuid NOT NULL REFERENCES turn(id),
  params_hash text NOT NULL,
  approved boolean NOT NULL,
  consumed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION erase_device(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('sga.allow_erasure', 'on', true);
  DELETE FROM trajectory WHERE turn_id IN (SELECT id FROM turn WHERE device_id = target);
  DELETE FROM turn_event WHERE turn_id IN (SELECT id FROM turn WHERE device_id = target);
  DELETE FROM action_result WHERE turn_id IN (SELECT id FROM turn WHERE device_id = target);
  DELETE FROM confirmation WHERE turn_id IN (SELECT id FROM turn WHERE device_id = target);
  DELETE FROM turn WHERE device_id = target;
  DELETE FROM device_usage WHERE device_id = target;
  DELETE FROM device WHERE id = target;
  PERFORM set_config('sga.allow_erasure', 'off', true);
END;
$$;

GRANT SELECT, INSERT, UPDATE ON device TO sg_app;
GRANT SELECT, INSERT, UPDATE ON turn TO sg_app;
GRANT SELECT, INSERT ON trajectory, turn_event TO sg_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON action_result TO sg_app;
GRANT SELECT, INSERT, UPDATE ON device_usage, ip_usage, confirmation TO sg_app;
GRANT USAGE, SELECT ON SEQUENCE trajectory_id_seq TO sg_app;
GRANT EXECUTE ON FUNCTION erase_device(uuid) TO sg_app;

REVOKE UPDATE, DELETE, TRUNCATE ON trajectory FROM sg_app;
REVOKE UPDATE, DELETE, TRUNCATE ON turn_event FROM sg_app;
