-- Only sg_app cross-product read: identifiers, not content, before product scope exists.
CREATE FUNCTION sg_list_in_flight_turns()
RETURNS TABLE (product_id uuid, conversation_id uuid, turn_id uuid)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT c.product_id, c.id, c.active_turn_id
    FROM conversation c
   WHERE c.active_turn_id IS NOT NULL
   ORDER BY c.created_at
   LIMIT 1000;
$$;

REVOKE ALL ON FUNCTION sg_list_in_flight_turns() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sg_list_in_flight_turns() TO sg_app;
