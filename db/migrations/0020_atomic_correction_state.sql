BEGIN;

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

CREATE OR REPLACE FUNCTION public.decide_manager_correction(
  p_store_id UUID,
  p_request_id UUID,
  p_decision TEXT,
  p_resolved_event_type TEXT,
  p_resolved_occurred_at TIMESTAMPTZ
)
RETURNS TABLE (
  correction_id UUID,
  staff_id UUID,
  status TEXT,
  operation TEXT,
  requested_event_type TEXT,
  requested_occurred_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  manager_id UUID;
  target_staff_id UUID;
  current_operation TEXT;
  result_operation TEXT;
  result_event_type TEXT;
  result_occurred_at TIMESTAMPTZ;
  latest_event_type TEXT;
  latest_event_at TIMESTAMPTZ;
  latest_original_event_id UUID;
  next_state TEXT;
BEGIN
  IF p_decision NOT IN ('APPROVED', 'REJECTED')
    OR (p_resolved_event_type IS NOT NULL AND p_resolved_event_type NOT IN ('CHECK_IN', 'BREAK_START', 'BREAK_END', 'CHECK_OUT')) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_DECISION';
  END IF;

  IF NOT public.app_manager_store_allowed(p_store_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MANAGER_ACCESS_REQUIRED';
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

  SELECT cr.staff_id
  INTO target_staff_id
  FROM public.correction_requests cr
  WHERE cr.id = p_request_id
    AND cr.store_id = p_store_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM 1
  FROM public.staff_states ss
  WHERE ss.staff_id = target_staff_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STAFF_STATE_NOT_FOUND';
  END IF;

  SELECT cr.operation
  INTO current_operation
  FROM public.correction_requests cr
  WHERE cr.id = p_request_id
    AND cr.store_id = p_store_id
    AND cr.status = 'PENDING'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_decision = 'APPROVED' AND current_operation = 'REVIEW' THEN
    IF p_resolved_event_type IS NULL OR p_resolved_occurred_at IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'RESOLUTION_REQUIRED';
    END IF;
    result_operation := 'ADD';
    result_event_type := p_resolved_event_type;
    result_occurred_at := p_resolved_occurred_at;
  ELSIF p_decision = 'APPROVED' AND current_operation <> 'ADD' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'UNSUPPORTED_APPROVAL';
  ELSE
    result_operation := current_operation;
  END IF;

  UPDATE public.correction_requests cr
  SET operation = result_operation,
      requested_event_type = CASE
        WHEN p_decision = 'APPROVED' AND current_operation = 'REVIEW' THEN result_event_type
        ELSE cr.requested_event_type
      END,
      requested_occurred_at = CASE
        WHEN p_decision = 'APPROVED' AND current_operation = 'REVIEW' THEN result_occurred_at
        ELSE cr.requested_occurred_at
      END,
      status = p_decision,
      approved_by = CASE WHEN p_decision = 'APPROVED' THEN manager_id::TEXT ELSE cr.approved_by END,
      approved_at = CASE WHEN p_decision = 'APPROVED' THEN NOW() ELSE cr.approved_at END,
      rejected_at = CASE WHEN p_decision = 'REJECTED' THEN NOW() ELSE cr.rejected_at END
  WHERE cr.id = p_request_id
    AND cr.store_id = p_store_id
    AND cr.status = 'PENDING'
  RETURNING cr.operation, cr.requested_event_type, cr.requested_occurred_at
  INTO result_operation, result_event_type, result_occurred_at;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_decision = 'APPROVED' THEN
    SELECT epe.event_type, epe.occurred_at, epe.original_event_id
    INTO latest_event_type, latest_event_at, latest_original_event_id
    FROM public.effective_punch_events epe
    WHERE epe.staff_id = target_staff_id
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
    WHERE ss.staff_id = target_staff_id;
  END IF;

  RETURN QUERY
  SELECT
    p_request_id,
    target_staff_id,
    p_decision,
    result_operation,
    result_event_type,
    result_occurred_at;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_manager_direct_correction(UUID, UUID, TEXT, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decide_manager_correction(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.apply_manager_direct_correction(UUID, UUID, TEXT, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT) TO onogami_app;
GRANT EXECUTE ON FUNCTION public.decide_manager_correction(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) TO onogami_app;

COMMIT;
