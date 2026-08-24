CREATE FUNCTION sg_purge_product(p_product_id uuid)
RETURNS TABLE (table_name text, rows_removed bigint)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  removed bigint;
BEGIN
  ALTER TABLE step DISABLE TRIGGER step_append_only;

  DELETE FROM step WHERE product_id = p_product_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  table_name := 'step'; rows_removed := removed; RETURN NEXT;

  ALTER TABLE step ENABLE TRIGGER step_append_only;

  DELETE FROM message WHERE product_id = p_product_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  table_name := 'message'; rows_removed := removed; RETURN NEXT;

  DELETE FROM conversation WHERE product_id = p_product_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  table_name := 'conversation'; rows_removed := removed; RETURN NEXT;

  DELETE FROM end_user WHERE product_id = p_product_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  table_name := 'end_user'; rows_removed := removed; RETURN NEXT;

  DELETE FROM chunk WHERE product_id = p_product_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  table_name := 'chunk'; rows_removed := removed; RETURN NEXT;

  DELETE FROM document WHERE product_id = p_product_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  table_name := 'document'; rows_removed := removed; RETURN NEXT;

  DELETE FROM tool WHERE product_id = p_product_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  table_name := 'tool'; rows_removed := removed; RETURN NEXT;

  DELETE FROM procedure WHERE product_id = p_product_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  table_name := 'procedure'; rows_removed := removed; RETURN NEXT;

  DELETE FROM product_secret WHERE product_id = p_product_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  table_name := 'product_secret'; rows_removed := removed; RETURN NEXT;

  DELETE FROM product WHERE id = p_product_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  table_name := 'product'; rows_removed := removed; RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION sg_purge_product(uuid) FROM PUBLIC;
