BEGIN;

-- A paired break remains two ordinary ADD events in the effective-event view.
-- Only its leader carries the operation identity. Existing rows stay ungrouped.
ALTER TABLE public.correction_requests
  ADD COLUMN group_id UUID,
  ADD COLUMN requested_business_date DATE;
ALTER TABLE public.correction_requests
  ADD CONSTRAINT fk_correction_group_staff_store
    FOREIGN KEY (group_id, staff_id, store_id)
    REFERENCES public.correction_requests(id, staff_id, store_id),
  ADD CONSTRAINT correction_group_shape CHECK (
    group_id IS NULL OR (
      operation = 'ADD' AND requested_event_type IN ('BREAK_START', 'BREAK_END')
      AND ((requested_event_type = 'BREAK_START') = (group_id = id))
      AND (client_request_id IS NULL OR group_id = id)
    )
  );
CREATE UNIQUE INDEX correction_group_event_type
  ON public.correction_requests(group_id, requested_event_type)
  WHERE group_id IS NOT NULL;

-- Keep the stored business day of new additions. Historical rows retain their
-- old interpretation. When a new addition is replaced at another time, resolve
-- its check-in again instead of splitting the shift or using a stale override.
-- CREATE OR REPLACE retains grants; security_invoker remains explicit.
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
effective_check_ins AS (
  SELECT effective_id, store_id, staff_id, occurred_at, business_date
  FROM effective_originals WHERE event_type = 'CHECK_IN'
  UNION ALL
  SELECT addition.id, addition.store_id, addition.staff_id,
    COALESCE(lm.requested_occurred_at, addition.requested_occurred_at),
    ((COALESCE(lm.requested_occurred_at, addition.requested_occurred_at) AT TIME ZONE s.timezone)
      - make_interval(mins => s.business_day_start_minute))::DATE
  FROM public.correction_requests addition
  JOIN public.stores s ON s.id = addition.store_id
  LEFT JOIN latest_addition_modifiers lm ON lm.target_correction_id = addition.id
  WHERE addition.status = 'APPROVED' AND addition.operation = 'ADD'
    AND COALESCE(lm.requested_event_type, addition.requested_event_type) = 'CHECK_IN'
    AND COALESCE(lm.requested_occurred_at, addition.requested_occurred_at) IS NOT NULL
    AND lm.operation IS DISTINCT FROM 'VOID'
),
effective_additions AS (
  SELECT addition.id AS effective_id, NULL::UUID AS original_event_id,
    COALESCE(lm.id, addition.id) AS correction_request_id, addition.store_id, addition.staff_id,
    COALESCE(lm.requested_event_type, addition.requested_event_type) AS event_type,
    COALESCE(lm.requested_occurred_at, addition.requested_occurred_at) AS occurred_at,
    COALESCE(
      CASE WHEN addition.requested_business_date IS NOT NULL THEN
        CASE WHEN lm.id IS NULL OR (
          lm.requested_occurred_at IS NOT DISTINCT FROM addition.requested_occurred_at
          AND lm.requested_event_type IS NOT DISTINCT FROM addition.requested_event_type
        ) THEN addition.requested_business_date
        WHEN COALESCE(lm.requested_event_type, addition.requested_event_type) <> 'CHECK_IN' THEN (
          SELECT check_in.business_date FROM effective_check_ins check_in
          WHERE check_in.store_id = addition.store_id AND check_in.staff_id = addition.staff_id
            AND check_in.occurred_at <= COALESCE(lm.requested_occurred_at, addition.requested_occurred_at)
          ORDER BY check_in.occurred_at DESC, check_in.effective_id DESC LIMIT 1
        ) ELSE NULL END
      ELSE NULL END,
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
)
SELECT * FROM effective_originals
UNION ALL
SELECT * FROM effective_additions;

-- Read-only preflight and authoritative write/approval guard share this logic.
-- Locking the state row serializes it with punches and all correction writers.
CREATE FUNCTION public.validate_correction_addition(
  p_store_id UUID,
  p_staff_id UUID,
  p_event_type TEXT,
  p_occurred_at TIMESTAMPTZ,
  p_break_ended_at TIMESTAMPTZ,
  p_exclude_request_id UUID DEFAULT NULL
)
RETURNS DATE
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_mode TEXT := public.app_request_setting('mode');
  store_timezone TEXT;
  day_start INTEGER;
  candidate_day DATE;
  check_in_day DATE;
  baseline_state TEXT := 'OFF_DUTY';
  proposed_state TEXT := 'OFF_DUTY';
  baseline_next TEXT;
  proposed_next TEXT;
  item RECORD;
BEGIN
  IF request_mode = 'staff' THEN
    IF NOT COALESCE(public.app_actor_owns_staff(p_staff_id), FALSE)
      OR NOT COALESCE(public.app_token_store_allowed(p_store_id), FALSE) THEN
      RAISE EXCEPTION 'STAFF_OR_STORE_NOT_FOUND';
    END IF;
  ELSIF request_mode IS DISTINCT FROM 'manager'
    OR NOT COALESCE(public.app_manager_store_allowed(p_store_id), FALSE)
    OR NOT COALESCE(public.app_manager_staff_allowed(p_staff_id), FALSE) THEN
    RAISE EXCEPTION 'MANAGER_ACCESS_REQUIRED';
  END IF;

  SELECT store.timezone, store.business_day_start_minute INTO store_timezone, day_start
  FROM public.staff_states ss
  JOIN public.staff st ON st.id = ss.staff_id
  JOIN public.stores store ON store.id = st.store_id
  WHERE st.id = p_staff_id AND st.store_id = p_store_id AND store.status = 'active'
    AND (request_mode = 'manager' OR st.status = 'active')
  FOR UPDATE OF ss;
  IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_OR_STORE_NOT_FOUND'; END IF;

  IF p_event_type IS NULL OR p_event_type NOT IN ('CHECK_IN', 'BREAK_START', 'BREAK_END', 'CHECK_OUT')
    OR p_occurred_at IS NULL
    OR (p_break_ended_at IS NOT NULL AND (p_event_type <> 'BREAK_START' OR p_break_ended_at <= p_occurred_at)) THEN
    RAISE EXCEPTION 'INVALID_CORRECTION_REQUEST';
  END IF;
  IF request_mode = 'staff' AND (
    p_occurred_at < NOW() - INTERVAL '62 days' OR p_occurred_at > NOW() + INTERVAL '5 minutes'
    OR p_break_ended_at > NOW() + INTERVAL '5 minutes'
  ) THEN RAISE EXCEPTION 'OCCURRED_AT_OUT_OF_RANGE'; END IF;

  candidate_day := ((p_occurred_at AT TIME ZONE store_timezone) - make_interval(mins => day_start))::DATE;
  IF p_event_type <> 'CHECK_IN' THEN
    -- Match ordinary punches: an ongoing shift keeps its check-in business day
    -- even when a break or checkout crosses midnight or the 05:00 boundary.
    SELECT epe.business_date INTO check_in_day FROM public.effective_punch_events epe
    WHERE epe.staff_id = p_staff_id AND epe.store_id = p_store_id
      AND epe.event_type = 'CHECK_IN' AND epe.occurred_at <= p_occurred_at
    ORDER BY epe.occurred_at DESC, epe.effective_id DESC LIMIT 1;
    candidate_day := COALESCE(check_in_day, candidate_day);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.effective_punch_events epe
    WHERE epe.staff_id = p_staff_id AND epe.store_id = p_store_id
      AND (epe.occurred_at = p_occurred_at OR epe.occurred_at = p_break_ended_at)
  ) THEN RAISE EXCEPTION 'CORRECTION_TIME_CONFLICT'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.correction_requests cr
    WHERE cr.staff_id = p_staff_id AND cr.store_id = p_store_id AND cr.status = 'PENDING'
      AND COALESCE(cr.group_id, cr.id) IS DISTINCT FROM p_exclude_request_id
      AND ((cr.requested_event_type = p_event_type AND cr.requested_occurred_at = p_occurred_at)
        OR (cr.requested_event_type = 'BREAK_END' AND cr.requested_occurred_at = p_break_ended_at))
  ) THEN RAISE EXCEPTION 'CORRECTION_PENDING_CONFLICT'; END IF;
  IF p_break_ended_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.effective_punch_events epe
    WHERE epe.staff_id = p_staff_id AND epe.store_id = p_store_id
      AND epe.event_type = 'CHECK_IN' AND epe.business_date IS DISTINCT FROM candidate_day
      AND epe.occurred_at > p_occurred_at AND epe.occurred_at < p_break_ended_at
  ) THEN
    -- Crossing the clock boundary is valid; crossing into a separate shift is not.
    RAISE EXCEPTION 'CORRECTION_SEQUENCE_INVALID';
  END IF;

  -- Replay the affected business day twice. Invalid existing events do not move
  -- state (as in daily attendance); incomplete shifts alone do not block repairs.
  FOR item IN
    SELECT e.event_type, e.occurred_at, e.effective_id, e.candidate
    FROM (
      SELECT epe.event_type, epe.occurred_at, epe.effective_id, FALSE AS candidate
      FROM public.effective_punch_events epe
      WHERE epe.staff_id = p_staff_id AND epe.store_id = p_store_id
        AND epe.business_date = candidate_day
      UNION ALL SELECT p_event_type, p_occurred_at, NULL::UUID, TRUE
      UNION ALL SELECT 'BREAK_END', p_break_ended_at, NULL::UUID, TRUE WHERE p_break_ended_at IS NOT NULL
    ) e ORDER BY e.occurred_at, e.effective_id
  LOOP
    proposed_next := CASE
      WHEN proposed_state = 'OFF_DUTY' AND item.event_type = 'CHECK_IN' THEN 'WORKING'
      WHEN proposed_state = 'WORKING' AND item.event_type = 'BREAK_START' THEN 'ON_BREAK'
      WHEN proposed_state = 'WORKING' AND item.event_type = 'CHECK_OUT' THEN 'OFF_DUTY'
      WHEN proposed_state = 'ON_BREAK' AND item.event_type = 'BREAK_END' THEN 'WORKING'
      ELSE NULL END;
    IF item.candidate THEN
      IF proposed_next IS NULL THEN
        IF item.event_type = 'BREAK_END' THEN RAISE EXCEPTION 'CORRECTION_BREAK_START_REQUIRED'; END IF;
        RAISE EXCEPTION 'CORRECTION_SEQUENCE_INVALID';
      END IF;
    ELSE
      baseline_next := CASE
        WHEN baseline_state = 'OFF_DUTY' AND item.event_type = 'CHECK_IN' THEN 'WORKING'
        WHEN baseline_state = 'WORKING' AND item.event_type = 'BREAK_START' THEN 'ON_BREAK'
        WHEN baseline_state = 'WORKING' AND item.event_type = 'CHECK_OUT' THEN 'OFF_DUTY'
        WHEN baseline_state = 'ON_BREAK' AND item.event_type = 'BREAK_END' THEN 'WORKING'
        ELSE NULL END;
      IF baseline_next IS NOT NULL AND proposed_next IS NULL THEN
        RAISE EXCEPTION 'CORRECTION_SEQUENCE_INVALID';
      END IF;
      baseline_state := COALESCE(baseline_next, baseline_state);
    END IF;
    proposed_state := COALESCE(proposed_next, proposed_state);
  END LOOP;
  RETURN candidate_day;
END;
$$;

CREATE FUNCTION public.submit_staff_correction(
  p_store_id UUID, p_staff_id UUID, p_client_request_id UUID, p_category TEXT,
  p_target_event_id UUID, p_expected_revision_id UUID, p_event_type TEXT,
  p_occurred_at TIMESTAMPTZ, p_reason TEXT, p_break_ended_at TIMESTAMPTZ
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
  leader_id UUID;
  saved_break_ended_at TIMESTAMPTZ;
  candidate_day DATE;
BEGIN
  IF public.app_request_setting('mode') IS DISTINCT FROM 'staff'
    OR NOT COALESCE(public.app_actor_owns_staff(p_staff_id), FALSE)
    OR NOT COALESCE(public.app_token_store_allowed(p_store_id), FALSE) THEN
    RAISE EXCEPTION 'STAFF_OR_STORE_NOT_FOUND';
  END IF;
  IF p_client_request_id IS NULL OR p_category IS NULL
    OR p_category NOT IN ('MISTAKE', 'MISSED', 'MISSED_BREAK', 'OTHER')
    OR (p_category <> 'MISSED_BREAK' AND p_break_ended_at IS NOT NULL) THEN
    RAISE EXCEPTION 'INVALID_CORRECTION_REQUEST';
  END IF;
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

  -- Do not add a null key to legacy intents: saved 0040 requests must replay exactly.
  payload := jsonb_build_object(
    'category', p_category, 'targetEventId', p_target_event_id,
    'expectedRevisionId', p_expected_revision_id, 'eventType', p_event_type,
    'occurredAt', p_occurred_at, 'reason', p_reason
  );
  IF p_category = 'MISSED_BREAK' THEN
    payload := payload || jsonb_build_object('breakEndedAt', p_break_ended_at);
  END IF;
  SELECT cr.* INTO saved FROM public.correction_requests cr
  WHERE cr.staff_id = p_staff_id AND cr.store_id = p_store_id
    AND cr.client_request_id = p_client_request_id;
  IF FOUND THEN
    IF saved.client_request_payload IS DISTINCT FROM payload THEN
      RAISE EXCEPTION 'CLIENT_REQUEST_CONFLICT';
    END IF;
    SELECT cr.requested_occurred_at INTO saved_break_ended_at
    FROM public.correction_requests cr
    WHERE cr.group_id = saved.group_id AND cr.id <> saved.id;
    RETURN QUERY SELECT 'already_received'::TEXT,
      jsonb_build_object('id', saved.id, 'status', saved.status,
        'requested_event_type', saved.requested_event_type,
        'requested_occurred_at', saved.requested_occurred_at,
        'group_id', saved.group_id, 'requested_break_ended_at', saved_break_ended_at);
    RETURN;
  END IF;

  IF p_category = 'MISTAKE' THEN
    IF p_target_event_id IS NULL OR p_expected_revision_id IS NULL
      OR p_event_type IS NULL OR p_event_type NOT IN ('CHECK_OUT', 'BREAK_START')
      OR p_occurred_at IS NOT NULL OR p_reason IS NOT NULL THEN
      RAISE EXCEPTION 'INVALID_CORRECTION_REQUEST';
    END IF;
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
    IF p_category IN ('MISSED', 'MISSED_BREAK') THEN
      IF p_reason IS NOT NULL OR (p_category = 'MISSED_BREAK' AND (p_event_type IS DISTINCT FROM 'BREAK_START' OR p_break_ended_at IS NULL)) THEN
        RAISE EXCEPTION 'INVALID_CORRECTION_REQUEST';
      END IF;
      candidate_day := public.validate_correction_addition(p_store_id, p_staff_id, p_event_type, p_occurred_at, p_break_ended_at);
    ELSIF p_event_type IS NOT NULL OR p_occurred_at IS NOT NULL
      OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
      RAISE EXCEPTION 'INVALID_CORRECTION_REQUEST';
    END IF;
    leader_id := gen_random_uuid();
    INSERT INTO public.correction_requests (
      id, store_id, staff_id, operation, requested_event_type, requested_occurred_at,
      reason, status, client_request_id, client_request_payload, group_id, requested_business_date
    ) VALUES (
      leader_id, p_store_id, p_staff_id, CASE WHEN p_category = 'OTHER' THEN 'REVIEW' ELSE 'ADD' END,
      p_event_type, p_occurred_at,
      CASE WHEN p_category = 'OTHER' THEN p_reason ELSE '打刻を押し忘れた' END,
      'PENDING', p_client_request_id, payload, CASE WHEN p_category = 'MISSED_BREAK' THEN leader_id ELSE NULL END, candidate_day
    ) RETURNING * INTO saved;
    IF p_category = 'MISSED_BREAK' THEN
      INSERT INTO public.correction_requests (
        store_id, staff_id, operation, requested_event_type, requested_occurred_at, reason, status, group_id, requested_business_date
      ) VALUES (
        p_store_id, p_staff_id, 'ADD', 'BREAK_END', p_break_ended_at, '打刻を押し忘れた', 'PENDING', leader_id, candidate_day
      );
    END IF;
  END IF;
  RETURN QUERY SELECT CASE WHEN p_category = 'MISTAKE' THEN 'applied' ELSE 'submitted' END,
    jsonb_build_object('id', saved.id, 'status', saved.status,
      'requested_event_type', saved.requested_event_type, 'requested_occurred_at', saved.requested_occurred_at,
      'group_id', saved.group_id, 'requested_break_ended_at', p_break_ended_at);
END;
$$;

-- Old callers and old pending operations get the same validation and idempotency.
CREATE OR REPLACE FUNCTION public.submit_staff_correction(
  p_store_id UUID, p_staff_id UUID, p_client_request_id UUID, p_category TEXT,
  p_target_event_id UUID, p_expected_revision_id UUID, p_event_type TEXT,
  p_occurred_at TIMESTAMPTZ, p_reason TEXT
)
RETURNS TABLE(result_status TEXT, correction_request JSONB)
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT * FROM public.submit_staff_correction(p_store_id, p_staff_id, p_client_request_id, p_category,
    p_target_event_id, p_expected_revision_id, p_event_type, p_occurred_at, p_reason, NULL::TIMESTAMPTZ)
$$;

CREATE OR REPLACE FUNCTION public.decide_manager_correction(
  p_store_id UUID, p_request_id UUID, p_decision TEXT,
  p_resolved_event_type TEXT, p_resolved_occurred_at TIMESTAMPTZ
)
RETURNS TABLE(correction_id UUID, staff_id UUID, status TEXT, operation TEXT,
  requested_event_type TEXT, requested_occurred_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  manager_id UUID;
  selected public.correction_requests%ROWTYPE;
  leader public.correction_requests%ROWTYPE;
  child public.correction_requests%ROWTYPE;
  result_type TEXT;
  result_time TIMESTAMPTZ;
  latest_type TEXT;
  latest_at TIMESTAMPTZ;
  latest_original_id UUID;
  candidate_day DATE;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('APPROVED', 'REJECTED')
    OR (p_resolved_event_type IS NOT NULL AND p_resolved_event_type NOT IN ('CHECK_IN', 'BREAK_START', 'BREAK_END', 'CHECK_OUT')) THEN
    RAISE EXCEPTION 'INVALID_DECISION';
  END IF;
  IF NOT COALESCE(public.app_manager_store_allowed(p_store_id), FALSE) THEN
    RAISE EXCEPTION 'MANAGER_ACCESS_REQUIRED';
  END IF;
  SELECT st.id INTO manager_id FROM public.staff st
  JOIN public.stores store ON store.id = st.store_id
  WHERE st.store_id = p_store_id AND st.line_user_id = public.app_request_setting('line_user_id')
    AND st.role = 'MANAGER' AND st.status = 'active' AND store.status = 'active'
  ORDER BY st.created_at LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'MANAGER_ACCESS_REQUIRED'; END IF;
  SELECT cr.* INTO selected FROM public.correction_requests cr
  WHERE cr.id = p_request_id AND cr.store_id = p_store_id;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM 1 FROM public.staff_states ss WHERE ss.staff_id = selected.staff_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_STATE_NOT_FOUND'; END IF;
  SELECT cr.* INTO leader FROM public.correction_requests cr
  WHERE cr.id = COALESCE(selected.group_id, selected.id) AND cr.store_id = p_store_id
    AND cr.staff_id = selected.staff_id AND cr.status = 'PENDING' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF leader.group_id IS NOT NULL THEN
    SELECT cr.* INTO child FROM public.correction_requests cr
    WHERE cr.group_id = leader.id AND cr.id <> leader.id AND cr.store_id = p_store_id
      AND cr.staff_id = leader.staff_id FOR UPDATE;
    IF NOT FOUND OR child.status <> 'PENDING' THEN RAISE EXCEPTION 'INVALID_CORRECTION_REQUEST'; END IF;
  END IF;
  result_type := leader.requested_event_type;
  result_time := leader.requested_occurred_at;
  IF p_decision = 'APPROVED' THEN
    IF leader.operation = 'REVIEW' THEN
      IF p_resolved_event_type IS NULL OR p_resolved_occurred_at IS NULL THEN
        RAISE EXCEPTION 'RESOLUTION_REQUIRED';
      END IF;
      result_type := p_resolved_event_type;
      result_time := p_resolved_occurred_at;
    ELSIF leader.operation <> 'ADD' THEN RAISE EXCEPTION 'UNSUPPORTED_APPROVAL'; END IF;
    candidate_day := public.validate_correction_addition(p_store_id, leader.staff_id,
      result_type, result_time, child.requested_occurred_at, leader.id);
  END IF;
  UPDATE public.correction_requests cr SET
    operation = CASE WHEN p_decision = 'APPROVED' THEN 'ADD' ELSE cr.operation END,
    requested_event_type = CASE WHEN cr.id = leader.id THEN result_type ELSE cr.requested_event_type END,
    requested_occurred_at = CASE WHEN cr.id = leader.id THEN result_time ELSE cr.requested_occurred_at END,
    requested_business_date = CASE WHEN p_decision = 'APPROVED' THEN candidate_day ELSE cr.requested_business_date END,
    status = p_decision,
    approved_by = CASE WHEN p_decision = 'APPROVED' THEN manager_id::TEXT ELSE cr.approved_by END,
    approved_at = CASE WHEN p_decision = 'APPROVED' THEN NOW() ELSE cr.approved_at END,
    rejected_at = CASE WHEN p_decision = 'REJECTED' THEN NOW() ELSE cr.rejected_at END
  WHERE cr.store_id = p_store_id AND cr.staff_id = leader.staff_id
    AND (cr.id = leader.id OR cr.group_id = leader.id) AND cr.status = 'PENDING';
  IF p_decision = 'APPROVED' THEN
    SELECT epe.event_type, epe.occurred_at, epe.original_event_id INTO latest_type, latest_at, latest_original_id
    FROM public.effective_punch_events epe WHERE epe.staff_id = leader.staff_id AND epe.store_id = p_store_id
    ORDER BY epe.occurred_at DESC, epe.effective_id DESC LIMIT 1;
    UPDATE public.staff_states ss SET
      state = CASE WHEN latest_type IS NULL OR latest_type = 'CHECK_OUT' THEN 'OFF_DUTY'
        WHEN latest_type = 'BREAK_START' THEN 'ON_BREAK' ELSE 'WORKING' END,
      last_event_id = latest_original_id, last_event_at = latest_at, updated_at = clock_timestamp()
    WHERE ss.staff_id = leader.staff_id;
  END IF;
  RETURN QUERY SELECT leader.id, leader.staff_id, p_decision,
    CASE WHEN p_decision = 'APPROVED' THEN 'ADD' ELSE leader.operation END, result_type, result_time;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_correction_addition(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_staff_correction(UUID, UUID, UUID, TEXT, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_correction_addition(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, UUID) TO onogami_app;
GRANT EXECUTE ON FUNCTION public.submit_staff_correction(UUID, UUID, UUID, TEXT, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ) TO onogami_app;
-- CREATE OR REPLACE retains the existing restricted privileges of the wrappers.

COMMIT;
