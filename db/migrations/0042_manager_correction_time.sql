BEGIN;

-- Keep the existing invoker privileges, store checks, audit history and state
-- recalculation. Only ADD/REPLACE gain the database-clock time restriction.
CREATE OR REPLACE FUNCTION public.apply_manager_direct_correction(
  p_store_id UUID,
  p_staff_id UUID,
  p_operation TEXT,
  p_target_event_id UUID,
  p_target_correction_id UUID,
  p_requested_event_type TEXT,
  p_requested_occurred_at TIMESTAMPTZ,
  p_reason TEXT
)
RETURNS TABLE (
  correction_id UUID,
  operation TEXT,
  status TEXT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  manager_id UUID;
  created_id UUID;
  latest_event_type TEXT;
  latest_event_at TIMESTAMPTZ;
  latest_original_event_id UUID;
  next_state TEXT;
BEGIN
  IF NOT public.app_manager_store_allowed(p_store_id)
    OR NOT public.app_manager_staff_allowed(p_staff_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MANAGER_ACCESS_REQUIRED';
  END IF;

  IF p_operation NOT IN ('ADD', 'REPLACE', 'VOID')
    OR NULLIF(BTRIM(p_reason), '') IS NULL
    OR LENGTH(p_reason) > 500
    OR (p_operation = 'ADD' AND (p_target_event_id IS NOT NULL OR p_target_correction_id IS NOT NULL))
    OR (p_operation IN ('REPLACE', 'VOID') AND ((p_target_event_id IS NULL) = (p_target_correction_id IS NULL)))
    OR (p_operation = 'VOID' AND (p_requested_event_type IS NOT NULL OR p_requested_occurred_at IS NOT NULL))
    OR (p_operation <> 'VOID' AND (p_requested_event_type IS NULL OR p_requested_occurred_at IS NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_CORRECTION';
  END IF;

  SELECT st.id
  INTO manager_id
  FROM public.staff st
  JOIN public.stores store ON store.id = st.store_id
  WHERE st.store_id = p_store_id
    AND st.line_user_id = public.app_request_setting('line_user_id')
    AND st.role = 'MANAGER'
    AND st.status = 'active'
    AND store.status = 'active'
  ORDER BY st.created_at ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MANAGER_ACCESS_REQUIRED';
  END IF;

  PERFORM 1
  FROM public.staff_states ss
  WHERE ss.staff_id = p_staff_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STAFF_STATE_NOT_FOUND';
  END IF;

  -- VOID must still remove an existing future mistake without adding a time.
  IF p_operation IN ('ADD', 'REPLACE') AND p_requested_occurred_at > NOW() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OCCURRED_AT_IN_FUTURE';
  END IF;

  INSERT INTO public.correction_requests (
    store_id,
    staff_id,
    operation,
    target_event_id,
    target_correction_id,
    requested_event_type,
    requested_occurred_at,
    reason,
    status,
    requested_at,
    approved_by,
    approved_at,
    created_at
  )
  VALUES (
    p_store_id,
    p_staff_id,
    p_operation,
    p_target_event_id,
    p_target_correction_id,
    p_requested_event_type,
    p_requested_occurred_at,
    p_reason,
    'APPROVED',
    NOW(),
    manager_id::TEXT,
    NOW(),
    NOW()
  )
  RETURNING id INTO created_id;

  SELECT epe.event_type, epe.occurred_at, epe.original_event_id
  INTO latest_event_type, latest_event_at, latest_original_event_id
  FROM public.effective_punch_events epe
  WHERE epe.staff_id = p_staff_id
  ORDER BY epe.occurred_at DESC, epe.effective_id DESC
  LIMIT 1;

  next_state := CASE
    WHEN latest_event_type IS NULL OR latest_event_type = 'CHECK_OUT' THEN 'OFF_DUTY'
    WHEN latest_event_type = 'BREAK_START' THEN 'ON_BREAK'
    ELSE 'WORKING'
  END;

  UPDATE public.staff_states ss
  SET state = next_state,
      last_event_id = latest_original_event_id,
      last_event_at = latest_event_at,
      updated_at = NOW()
  WHERE ss.staff_id = p_staff_id;

  RETURN QUERY SELECT created_id, p_operation, 'APPROVED'::TEXT;
END;
$$;

-- CREATE OR REPLACE retains the function's existing EXECUTE grants.
COMMIT;
