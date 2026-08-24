-- Startup recovery must find interrupted turns across every product before any product
-- scope exists. This is the only cross-product read the application role can perform, it
-- returns identifiers rather than content, and it exists so no turn is ever left hanging.
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
