BEGIN;

-- A shift belongs to its effective check-in's business day, including after a
-- correction crosses 05:00 or a month boundary. Original records and correction
-- history are untouched. CREATE OR REPLACE retains the view/function ACLs.
CREATE OR REPLACE VIEW public.effective_punch_events WITH (security_invoker = TRUE) AS
WITH latest_original_modifiers AS (
  SELECT DISTINCT ON (cr.target_event_id)
    cr.id, cr.target_event_id, cr.operation, cr.requested_event_type,
    cr.requested_occurred_at, cr.approved_at
  FROM public.correction_requests cr
  WHERE cr.status = 'APPROVED' AND cr.operation IN ('REPLACE', 'VOID') AND cr.target_event_id IS NOT NULL
  ORDER BY cr.target_event_id, cr.approved_at DESC NULLS LAST, cr.requested_at DESC, cr.id DESC
),
latest_addition_modifiers AS (
  SELECT DISTINCT ON (cr.target_correction_id)
    cr.id, cr.target_correction_id, cr.operation, cr.requested_event_type,
    cr.requested_occurred_at, cr.approved_at
  FROM public.correction_requests cr
  WHERE cr.status = 'APPROVED' AND cr.operation IN ('REPLACE', 'VOID') AND cr.target_correction_id IS NOT NULL
  ORDER BY cr.target_correction_id, cr.approved_at DESC NULLS LAST, cr.requested_at DESC, cr.id DESC
),
effective_originals AS (
  SELECT pe.id AS effective_id, pe.id AS original_event_id, lm.id AS correction_request_id,
    pe.store_id, pe.staff_id,
    COALESCE(lm.requested_event_type, pe.event_type) AS event_type,
    COALESCE(lm.requested_occurred_at, pe.occurred_at) AS occurred_at,
    CASE WHEN lm.operation = 'REPLACE' AND lm.requested_occurred_at IS NOT NULL
      THEN ((lm.requested_occurred_at AT TIME ZONE s.timezone) - make_interval(mins => s.business_day_start_minute))::DATE
      ELSE pe.business_date END AS business_date,
    pe.latitude, pe.longitude, pe.gps_accuracy_m, pe.distance_from_store_m,
    pe.location_status, pe.validation_status, pe.validation_code, pe.source, pe.created_at,
    (lm.operation = 'REPLACE') AS corrected, NULL::UUID AS origin_correction_id
  FROM public.punch_events pe
  JOIN public.stores s ON s.id = pe.store_id
  LEFT JOIN latest_original_modifiers lm ON lm.target_event_id = pe.id
  WHERE lm.operation IS DISTINCT FROM 'VOID'
),
effective_additions AS (
  SELECT addition.id AS effective_id, NULL::UUID AS original_event_id,
    COALESCE(lm.id, addition.id) AS correction_request_id, addition.store_id, addition.staff_id,
    COALESCE(lm.requested_event_type, addition.requested_event_type) AS event_type,
    COALESCE(lm.requested_occurred_at, addition.requested_occurred_at) AS occurred_at,
    COALESCE(CASE WHEN lm.id IS NULL THEN addition.requested_business_date END,
      ((COALESCE(lm.requested_occurred_at, addition.requested_occurred_at) AT TIME ZONE s.timezone)
        - make_interval(mins => s.business_day_start_minute))::DATE
    ) AS business_date,
    NULL::DOUBLE PRECISION AS latitude, NULL::DOUBLE PRECISION AS longitude,
    NULL::DOUBLE PRECISION AS gps_accuracy_m, NULL::DOUBLE PRECISION AS distance_from_store_m,
    'UNAVAILABLE'::TEXT AS location_status, 'WARNING'::TEXT AS validation_status,
    CASE WHEN lm.operation = 'REPLACE' THEN 'APPROVED_CORRECTION_REPLACE' ELSE 'APPROVED_CORRECTION_ADD' END::TEXT AS validation_code,
    'CORRECTION'::TEXT AS source, addition.created_at, TRUE AS corrected, addition.id AS origin_correction_id
  FROM public.correction_requests addition
  JOIN public.stores s ON s.id = addition.store_id
  LEFT JOIN latest_addition_modifiers lm ON lm.target_correction_id = addition.id
  WHERE addition.status = 'APPROVED' AND addition.operation = 'ADD'
    AND addition.requested_event_type IS NOT NULL AND addition.requested_occurred_at IS NOT NULL
    AND lm.operation IS DISTINCT FROM 'VOID'
),
all_events AS (
  SELECT * FROM effective_originals UNION ALL SELECT * FROM effective_additions
),
shift_groups AS (
  SELECT e.*, count(*) FILTER (WHERE event_type = 'CHECK_IN') OVER (
    PARTITION BY store_id, staff_id ORDER BY occurred_at, effective_id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS shift_group
  FROM all_events e
),
shift_events AS (
  SELECT e.*, first_value(business_date) OVER shift_window AS shift_day,
    count(*) FILTER (WHERE event_type = 'CHECK_OUT') OVER (
      PARTITION BY store_id, staff_id, shift_group ORDER BY occurred_at, effective_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS earlier_checkouts
  FROM shift_groups e
  WINDOW shift_window AS (
    PARTITION BY store_id, staff_id, shift_group ORDER BY occurred_at, effective_id
    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
  )
)
SELECT effective_id, original_event_id, correction_request_id, store_id, staff_id,
  event_type, occurred_at,
  -- An orphan after a closed shift must not borrow an unrelated earlier day.
  CASE WHEN shift_group = 0 OR earlier_checkouts > 0 THEN business_date
    ELSE shift_day END AS business_date,
  latitude, longitude, gps_accuracy_m, distance_from_store_m, location_status,
  validation_status, validation_code, source, created_at, corrected, origin_correction_id
FROM shift_events;


-- Pure sequence assessment, shared by the before/after save check. The caller
-- supplies only its RLS-visible events; this function reads no database rows.
CREATE OR REPLACE FUNCTION public.correction_day_sequences(p_events JSONB)
RETURNS TABLE(day TEXT, events JSONB, invalid INTEGER, open_check_in UUID)
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE item JSONB; current_state TEXT;
BEGIN
  FOR day, events IN
    SELECT e->>'day', jsonb_agg(e ORDER BY (e->>'at')::timestamptz, e->>'id')
    FROM jsonb_array_elements(p_events) e GROUP BY e->>'day'
  LOOP
    invalid := 0; open_check_in := NULL; current_state := 'OFF_DUTY';
    FOR item IN SELECT * FROM jsonb_array_elements(events) LOOP
      IF current_state = 'OFF_DUTY' AND item->>'type' = 'CHECK_IN' THEN
        current_state := 'WORKING'; open_check_in := (item->>'id')::uuid;
      ELSIF current_state = 'WORKING' AND item->>'type' = 'BREAK_START' THEN
        current_state := 'ON_BREAK';
      ELSIF current_state = 'ON_BREAK' AND item->>'type' = 'BREAK_END' THEN
        current_state := 'WORKING';
      ELSIF current_state = 'WORKING' AND item->>'type' = 'CHECK_OUT' THEN
        current_state := 'OFF_DUTY'; open_check_in := NULL;
      ELSE invalid := invalid + 1;
      END IF;
    END LOOP;
    RETURN NEXT;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.correction_day_sequences(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.correction_day_sequences(JSONB) TO onogami_app;

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
  before_events JSONB;
  after_events JSONB;
  changed_day RECORD;
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
    AND public.app_manager_store_allowed(st.store_id)
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

  -- Validate against the saved effective view under the same staff lock as the
  -- mutation. A moved check-in can affect both months and every event in its shift.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', e.effective_id, 'type', e.event_type, 'at', e.occurred_at, 'day', e.business_date
  ) ORDER BY e.business_date, e.occurred_at, e.effective_id), '[]'::jsonb)
  INTO before_events FROM public.effective_punch_events e
  WHERE e.store_id = p_store_id AND e.staff_id = p_staff_id;

  IF p_operation <> 'ADD' AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(before_events) e
    WHERE (e->>'id')::uuid = COALESCE(p_target_event_id, p_target_correction_id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TARGET_NOT_FOUND';
  END IF;
  IF p_operation <> 'VOID' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(before_events) e
    WHERE (e->>'at')::timestamptz = p_requested_occurred_at
      AND (e->>'id')::uuid IS DISTINCT FROM COALESCE(p_target_event_id, p_target_correction_id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'DUPLICATE_PUNCH_TIME';
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

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', e.effective_id, 'type', e.event_type, 'at', e.occurred_at, 'day', e.business_date
  ) ORDER BY e.business_date, e.occurred_at, e.effective_id), '[]'::jsonb)
  INTO after_events FROM public.effective_punch_events e
  WHERE e.store_id = p_store_id AND e.staff_id = p_staff_id;

  FOR changed_day IN
    SELECT a.*, b.invalid AS before_invalid
    FROM public.correction_day_sequences(after_events) a
    LEFT JOIN public.correction_day_sequences(before_events) b ON b.day = a.day
    WHERE a.events IS DISTINCT FROM b.events
  LOOP
    -- Retain gradual repairs of an already-invalid day; unrelated days do not
    -- block a repair. REPLACE must also not split a formerly complete shift.
    IF (changed_day.invalid > 0 AND changed_day.invalid >= COALESCE(changed_day.before_invalid, 0))
      OR (p_operation = 'REPLACE' AND changed_day.open_check_in IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.correction_day_sequences(before_events) b
        WHERE b.open_check_in = changed_day.open_check_in
      )) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_PUNCH_SEQUENCE';
    END IF;
  END LOOP;

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


-- Pending requests are not attendance, but their warning must follow the same
-- effective shift after its check-in moves. Keep the submitted date as history.
CREATE OR REPLACE FUNCTION public.correction_request_business_date(p_request_id UUID)
RETURNS DATE LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(target.business_date, check_in.business_date, cr.requested_business_date,
    ((COALESCE(cr.requested_occurred_at, cr.requested_at) AT TIME ZONE s.timezone)
      - make_interval(mins => s.business_day_start_minute))::date)
  FROM public.correction_requests cr
  JOIN public.stores s ON s.id = cr.store_id
  LEFT JOIN public.effective_punch_events target
    ON target.effective_id = COALESCE(cr.target_event_id, cr.target_correction_id)
    AND target.store_id = cr.store_id AND target.staff_id = cr.staff_id
  LEFT JOIN LATERAL (
    SELECT e.business_date FROM public.effective_punch_events e
    WHERE e.store_id = cr.store_id AND e.staff_id = cr.staff_id AND e.event_type = 'CHECK_IN'
      AND cr.operation = 'ADD' AND cr.requested_event_type IN ('BREAK_START', 'BREAK_END', 'CHECK_OUT')
      AND e.occurred_at <= cr.requested_occurred_at
      AND NOT EXISTS (
        SELECT 1 FROM public.effective_punch_events ended
        WHERE ended.store_id = e.store_id AND ended.staff_id = e.staff_id AND ended.event_type = 'CHECK_OUT'
          AND ended.occurred_at >= e.occurred_at AND ended.occurred_at < cr.requested_occurred_at
      )
    ORDER BY e.occurred_at DESC, e.effective_id DESC LIMIT 1
  ) check_in ON TRUE
  WHERE cr.id = p_request_id;
$$;
REVOKE ALL ON FUNCTION public.correction_request_business_date(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.correction_request_business_date(UUID) TO onogami_app;

-- Preserve the existing pending-start rule after its check-in is corrected.
CREATE OR REPLACE FUNCTION public.staff_pending_shift_start(p_staff_id UUID)
RETURNS TABLE (request_id UUID, checkout_at TIMESTAMPTZ, business_date DATE)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH candidates AS (
    SELECT cr.id, cr.requested_occurred_at, check_in.business_date,
      count(*) OVER () AS candidate_count
    FROM public.staff st
    JOIN public.stores s ON s.id = st.store_id
    JOIN public.staff_states ss ON ss.staff_id = st.id
    JOIN LATERAL (
      SELECT e.event_type, e.occurred_at FROM public.effective_punch_events e
      WHERE e.staff_id = st.id AND e.store_id = st.store_id
      ORDER BY e.occurred_at DESC, e.effective_id DESC LIMIT 1
    ) latest ON latest.event_type IN ('CHECK_IN', 'BREAK_END')
    JOIN LATERAL (
      SELECT e.business_date FROM public.effective_punch_events e
      WHERE e.staff_id = st.id AND e.store_id = st.store_id AND e.event_type = 'CHECK_IN'
        AND e.occurred_at <= latest.occurred_at
      ORDER BY e.occurred_at DESC, e.effective_id DESC LIMIT 1
    ) check_in ON TRUE
    JOIN public.correction_requests cr ON cr.staff_id = st.id AND cr.store_id = st.store_id
    WHERE st.id = p_staff_id AND st.status = 'active' AND s.status = 'active'
      AND public.app_request_setting('mode') = 'staff'
      AND public.app_actor_owns_staff(st.id) AND public.app_token_store_allowed(s.id)
      AND ss.state = 'WORKING'
      AND check_in.business_date < ((NOW() AT TIME ZONE s.timezone)
        - make_interval(mins => s.business_day_start_minute))::date
      AND cr.status = 'PENDING' AND cr.operation = 'ADD'
      AND cr.requested_event_type = 'CHECK_OUT' AND cr.group_id IS NULL
      AND cr.client_request_payload->>'category' = 'MISSED'
      AND public.correction_request_business_date(cr.id) = check_in.business_date
      AND cr.requested_occurred_at > latest.occurred_at AND cr.requested_occurred_at < NOW()
      AND NOT EXISTS (SELECT 1 FROM public.punch_events used
        WHERE used.previous_checkout_request_id = cr.id)
  )
  SELECT id, requested_occurred_at, candidates.business_date
  FROM candidates WHERE candidate_count = 1;
$$;

COMMIT;
