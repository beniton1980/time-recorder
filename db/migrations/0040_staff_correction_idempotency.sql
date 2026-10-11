BEGIN;

-- Existing correction history is unchanged. New staff requests carry an immutable
-- intent, so a lost response can be retried without toggling or duplicating it.
ALTER TABLE public.correction_requests
  ADD COLUMN client_request_id UUID,
  ADD COLUMN client_request_payload JSONB;

CREATE UNIQUE INDEX correction_requests_staff_client_request
  ON public.correction_requests(staff_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE FUNCTION public.submit_staff_correction(
  p_store_id UUID,
  p_staff_id UUID,
  p_client_request_id UUID,
  p_category TEXT,
  p_target_event_id UUID,
  p_expected_revision_id UUID,
  p_event_type TEXT,
  p_occurred_at TIMESTAMPTZ,
  p_reason TEXT
)
RETURNS TABLE(result_status TEXT, correction_request JSONB)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_state public.staff_states%ROWTYPE;
  saved public.correction_requests%ROWTYPE;
  target public.effective_punch_events%ROWTYPE;
  payload JSONB;
BEGIN
  IF public.app_request_setting('mode') IS DISTINCT FROM 'staff'
    OR NOT COALESCE(public.app_actor_owns_staff(p_staff_id), FALSE)
    OR NOT COALESCE(public.app_token_store_allowed(p_store_id), FALSE)
  THEN
    RAISE EXCEPTION 'STAFF_OR_STORE_NOT_FOUND';
  END IF;
  IF p_client_request_id IS NULL
    OR p_category IS NULL OR p_category NOT IN ('MISTAKE', 'MISSED', 'OTHER')
  THEN
    RAISE EXCEPTION 'INVALID_CORRECTION_REQUEST';
  END IF;

  -- Use the same actor lock as CHECK_IN when a correction can reopen a shift.
  IF p_category = 'MISTAKE' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(public.app_request_setting('line_user_id'), 0));
  END IF;
  SELECT ss.* INTO current_state
  FROM public.staff_states ss
  JOIN public.staff st ON st.id = ss.staff_id
  JOIN public.stores store ON store.id = st.store_id
  WHERE st.id = p_staff_id AND st.store_id = p_store_id
    AND st.line_user_id = public.app_request_setting('line_user_id')
    AND st.status = 'active' AND store.status = 'active'
  FOR UPDATE OF ss;
  IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_OR_STORE_NOT_FOUND'; END IF;

  payload := jsonb_build_object(
    'category', p_category, 'targetEventId', p_target_event_id,
    'expectedRevisionId', p_expected_revision_id, 'eventType', p_event_type,
    'occurredAt', p_occurred_at, 'reason', p_reason
  );
  SELECT cr.* INTO saved FROM public.correction_requests cr
  WHERE cr.staff_id = p_staff_id AND cr.store_id = p_store_id
    AND cr.client_request_id = p_client_request_id;
  IF FOUND THEN
    IF saved.client_request_payload IS DISTINCT FROM payload THEN
      RAISE EXCEPTION 'CLIENT_REQUEST_CONFLICT';
    END IF;
    RETURN QUERY SELECT 'already_received'::TEXT,
      jsonb_build_object('id', saved.id, 'status', saved.status,
        'requested_event_type', saved.requested_event_type,
        'requested_occurred_at', saved.requested_occurred_at);
    RETURN;
  END IF;

  IF p_category = 'MISTAKE' THEN
    IF p_target_event_id IS NULL OR p_expected_revision_id IS NULL
      OR p_event_type IS NULL OR p_event_type NOT IN ('CHECK_OUT', 'BREAK_START')
      OR p_occurred_at IS NOT NULL OR p_reason IS NOT NULL
    THEN RAISE EXCEPTION 'INVALID_CORRECTION_REQUEST'; END IF;
    SELECT epe.* INTO target FROM public.effective_punch_events epe
    WHERE epe.original_event_id = p_target_event_id
      AND epe.original_event_id = current_state.last_event_id
      AND epe.staff_id = p_staff_id AND epe.store_id = p_store_id
      AND COALESCE(epe.correction_request_id, epe.original_event_id) = p_expected_revision_id
      AND ((epe.event_type = 'CHECK_OUT' AND p_event_type = 'BREAK_START' AND current_state.state = 'OFF_DUTY')
        OR (epe.event_type = 'BREAK_START' AND p_event_type = 'CHECK_OUT' AND current_state.state = 'ON_BREAK'));
    IF NOT FOUND THEN RAISE EXCEPTION 'LAST_PUNCH_CHANGED'; END IF;
    IF p_event_type = 'BREAK_START' AND EXISTS (
      SELECT 1 FROM public.staff st
      JOIN public.staff_states ss ON ss.staff_id = st.id
      JOIN public.stores store ON store.id = st.store_id
      WHERE st.line_user_id = public.app_request_setting('line_user_id')
        AND st.store_id <> p_store_id AND st.status = 'active' AND store.status = 'active'
        AND ss.state IN ('WORKING', 'ON_BREAK')
    ) THEN RAISE EXCEPTION 'ACTIVE_AT_OTHER_STORE'; END IF;

    INSERT INTO public.correction_requests (
      store_id, staff_id, operation, target_event_id,
      requested_event_type, requested_occurred_at, reason,
      status, approved_by, approved_at, client_request_id, client_request_payload
    ) VALUES (
      p_store_id, p_staff_id, 'REPLACE', p_target_event_id,
      p_event_type, target.occurred_at, '前回の打刻ボタンを押し間違えた',
      'APPROVED', 'SELF_SERVICE_RULE', clock_timestamp(), p_client_request_id, payload
    ) RETURNING * INTO saved;
    UPDATE public.staff_states SET
      state = CASE WHEN p_event_type = 'BREAK_START' THEN 'ON_BREAK' ELSE 'OFF_DUTY' END,
      updated_at = clock_timestamp()
    WHERE staff_id = p_staff_id;
  ELSE
    IF p_target_event_id IS NOT NULL OR p_expected_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'INVALID_CORRECTION_REQUEST';
    END IF;
    IF p_category = 'MISSED' THEN
      IF p_event_type IS NULL OR p_event_type NOT IN ('CHECK_IN', 'BREAK_START', 'BREAK_END', 'CHECK_OUT')
        OR p_occurred_at IS NULL OR p_reason IS NOT NULL
      THEN RAISE EXCEPTION 'INVALID_CORRECTION_REQUEST'; END IF;
      -- Check the age only for new requests. An existing request stays retryable.
      IF p_occurred_at < NOW() - INTERVAL '62 days' OR p_occurred_at > NOW() + INTERVAL '5 minutes' THEN
        RAISE EXCEPTION 'OCCURRED_AT_OUT_OF_RANGE';
      END IF;
    ELSIF p_event_type IS NOT NULL OR p_occurred_at IS NOT NULL
      OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500
    THEN RAISE EXCEPTION 'INVALID_CORRECTION_REQUEST'; END IF;
    INSERT INTO public.correction_requests (
      store_id, staff_id, operation, requested_event_type, requested_occurred_at,
      reason, status, client_request_id, client_request_payload
    ) VALUES (
      p_store_id, p_staff_id, CASE WHEN p_category = 'MISSED' THEN 'ADD' ELSE 'REVIEW' END,
      p_event_type, p_occurred_at,
      CASE WHEN p_category = 'MISSED' THEN '打刻を押し忘れた' ELSE p_reason END,
      'PENDING', p_client_request_id, payload
    ) RETURNING * INTO saved;
  END IF;
  RETURN QUERY SELECT CASE WHEN p_category = 'MISTAKE' THEN 'applied' ELSE 'submitted' END,
    jsonb_build_object('id', saved.id, 'status', saved.status,
      'requested_event_type', saved.requested_event_type,
      'requested_occurred_at', saved.requested_occurred_at);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_staff_correction(UUID, UUID, UUID, TEXT, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_staff_correction(UUID, UUID, UUID, TEXT, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT) TO onogami_app;

COMMIT;
