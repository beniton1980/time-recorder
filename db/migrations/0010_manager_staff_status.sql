BEGIN;

CREATE OR REPLACE FUNCTION set_staff_membership_status(
  p_manager_line_user_id TEXT,
  p_staff_id UUID,
  p_status TEXT
)
RETURNS TABLE (
  staff_id UUID,
  legal_name TEXT,
  status TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  manager_store_id UUID;
  target_name TEXT;
  target_state TEXT;
BEGIN
  IF p_status NOT IN ('active', 'inactive') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_STAFF_STATUS';
  END IF;

  SELECT st.store_id
  INTO manager_store_id
  FROM staff st
  JOIN stores s ON s.id = st.store_id
  WHERE st.line_user_id = p_manager_line_user_id
    AND st.status = 'active'
    AND st.role = 'MANAGER'
    AND s.status = 'active'
  ORDER BY st.created_at ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MANAGER_ACCESS_REQUIRED';
  END IF;

  SELECT st.legal_name, COALESCE(ss.state, 'OFF_DUTY')
  INTO target_name, target_state
  FROM staff st
  JOIN staff_states ss ON ss.staff_id = st.id
  WHERE st.id = p_staff_id
    AND st.store_id = manager_store_id
    AND st.role = 'STAFF'
  FOR UPDATE OF st, ss;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STAFF_NOT_FOUND';
  END IF;

  IF p_status = 'inactive' AND target_state IN ('WORKING', 'ON_BREAK') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STAFF_ACTIVE_WORK';
  END IF;

  UPDATE staff st
  SET status = p_status, updated_at = NOW()
  WHERE st.id = p_staff_id;

  RETURN QUERY SELECT p_staff_id, target_name, p_status;
END;
$$;

COMMIT;

