BEGIN;

ALTER TABLE public.stores
  ADD COLUMN deleted_at TIMESTAMPTZ;

ALTER TABLE public.onboarding_requests
  ADD COLUMN archived_at TIMESTAMPTZ;

CREATE INDEX idx_onboarding_requests_active_status_submitted
  ON public.onboarding_requests(status, submitted_at)
  WHERE archived_at IS NULL;

CREATE OR REPLACE FUNCTION public.delete_onboarding_test_store(
  p_request_id UUID,
  p_confirmation_store_name TEXT
)
RETURNS TABLE (
  deleted_store_id UUID,
  deleted_store_name TEXT
)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  request_row public.onboarding_requests%ROWTYPE;
  store_row public.stores%ROWTYPE;
BEGIN
  SELECT *
  INTO request_row
  FROM public.onboarding_requests
  WHERE id = p_request_id
    AND archived_at IS NULL
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
  FROM public.stores
  WHERE id = request_row.provisioned_store_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TEST_STORE_NOT_FOUND';
  END IF;

  IF btrim(p_confirmation_store_name) <> store_row.name THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STORE_NAME_CONFIRMATION_MISMATCH';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.punch_events WHERE store_id = store_row.id
  ) OR EXISTS (
    SELECT 1 FROM public.correction_requests WHERE store_id = store_row.id
  ) OR EXISTS (
    SELECT 1 FROM public.monthly_attendance_deliveries WHERE store_id = store_row.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TEST_STORE_HAS_ATTENDANCE_HISTORY';
  END IF;

  UPDATE public.store_entry_tokens
  SET active = FALSE, revoked_at = COALESCE(revoked_at, NOW())
  WHERE store_id = store_row.id
    AND active = TRUE;

  UPDATE public.onboarding_manager_invites
  SET revoked_at = COALESCE(revoked_at, NOW())
  WHERE store_id = store_row.id
    AND used_at IS NULL;

  UPDATE public.staff
  SET status = 'inactive', updated_at = NOW()
  WHERE store_id = store_row.id
    AND status = 'active';

  UPDATE public.stores
  SET status = 'closed', deleted_at = NOW(), updated_at = NOW()
  WHERE id = store_row.id;

  UPDATE public.onboarding_requests
  SET archived_at = NOW(), updated_at = NOW()
  WHERE id = request_row.id;

  RETURN QUERY SELECT store_row.id, store_row.name;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_onboarding_test_store(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_onboarding_test_store(UUID, TEXT) TO onogami_app;

COMMIT;
