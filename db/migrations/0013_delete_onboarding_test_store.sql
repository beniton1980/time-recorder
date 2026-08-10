BEGIN;

CREATE OR REPLACE FUNCTION delete_onboarding_test_store(
  p_request_id UUID,
  p_confirmation_store_name TEXT
)
RETURNS TABLE (
  deleted_store_id UUID,
  deleted_store_name TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  request_row onboarding_requests%ROWTYPE;
  store_row stores%ROWTYPE;
BEGIN
  SELECT *
  INTO request_row
  FROM onboarding_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ONBOARDING_REQUEST_NOT_FOUND';
  END IF;

  IF request_row.status <> 'PROVISIONED'
     OR request_row.provisioned_store_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TEST_STORE_NOT_PROVISIONED';
  END IF;

  SELECT *
  INTO store_row
  FROM stores
  WHERE id = request_row.provisioned_store_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TEST_STORE_NOT_FOUND';
  END IF;

  IF btrim(p_confirmation_store_name) <> store_row.name THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STORE_NAME_CONFIRMATION_MISMATCH';
  END IF;

  IF EXISTS (
    SELECT 1 FROM punch_events WHERE store_id = store_row.id
  ) OR EXISTS (
    SELECT 1 FROM correction_requests WHERE store_id = store_row.id
  ) OR EXISTS (
    SELECT 1 FROM monthly_attendance_deliveries WHERE store_id = store_row.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TEST_STORE_HAS_ATTENDANCE_HISTORY';
  END IF;

  DELETE FROM staff_states
  WHERE staff_id IN (
    SELECT id FROM staff WHERE store_id = store_row.id
  );

  DELETE FROM staff
  WHERE store_id = store_row.id;

  DELETE FROM store_entry_tokens
  WHERE store_id = store_row.id;

  DELETE FROM onboarding_manager_invites
  WHERE store_id = store_row.id;

  DELETE FROM onboarding_requests
  WHERE id = request_row.id;

  DELETE FROM stores
  WHERE id = store_row.id;

  RETURN QUERY SELECT store_row.id, store_row.name;
END;
$$;

COMMIT;
