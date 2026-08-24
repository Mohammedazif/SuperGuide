CREATE FUNCTION sg_allocate_seq(p_conversation_id uuid) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  allocated bigint;
BEGIN
  UPDATE conversation
     SET next_seq = next_seq + 1
   WHERE id = p_conversation_id
  RETURNING next_seq - 1 INTO allocated;

  IF allocated IS NULL THEN
    RAISE EXCEPTION 'conversation % is not visible for sequence allocation', p_conversation_id;
  END IF;

  RETURN allocated;
END;
$$;

GRANT EXECUTE ON FUNCTION sg_allocate_seq(uuid) TO sg_app;

CREATE FUNCTION sg_notify_durable_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'sg_events',
    json_build_object('c', NEW.conversation_id, 's', NEW.seq)::text
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER message_notify
  AFTER INSERT ON message
  FOR EACH ROW EXECUTE FUNCTION sg_notify_durable_row();

CREATE TRIGGER step_notify
  AFTER INSERT ON step
  FOR EACH ROW EXECUTE FUNCTION sg_notify_durable_row();
