BEGIN;

CREATE OR REPLACE FUNCTION self_register_staff(
  p_store_token_hash TEXT,
  p_line_user_id TEXT,
  p_legal_name TEXT
)
RETURNS TABLE (
  staff_id UUID,
  store_id UUID,
  store_name TEXT,
  legal_name TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  target_store_id UUID;
  target_store_name TEXT;
  new_staff_id UUID;
BEGIN
  SELECT s.id, s.name
  INTO target_store_id, target_store_name
  FROM store_entry_tokens token
  JOIN stores s ON s.id = token.store_id
  WHERE token.token_hash = p_store_token_hash
    AND token.active = TRUE
    AND token.revoked_at IS NULL
    AND (token.expires_at IS NULL OR token.expires_at > NOW())
    AND s.status = 'active'
  FOR UPDATE OF token;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STORE_TOKEN_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1 FROM staff
    WHERE staff.store_id = target_store_id
      AND staff.line_user_id = p_line_user_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STAFF_ALREADY_REGISTERED';
  END IF;

  INSERT INTO staff (store_id, line_user_id, legal_name, status, role)
  VALUES (
    target_store_id,
    p_line_user_id,
    trim(p_legal_name),
    'active',
    'STAFF'
  )
  RETURNING id INTO new_staff_id;

  INSERT INTO staff_states (staff_id, state)
  VALUES (new_staff_id, 'OFF_DUTY');

  RETURN QUERY
  SELECT new_staff_id, target_store_id, target_store_name, trim(p_legal_name);
END;
$$;

COMMIT;
