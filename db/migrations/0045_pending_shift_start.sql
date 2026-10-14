BEGIN;

-- Record why a new shift could start without approving or inventing a checkout.
-- Existing events and the effective-event view retain their interpretation.
ALTER TABLE public.punch_events ADD COLUMN previous_checkout_request_id UUID;
ALTER TABLE public.punch_events
  ADD CONSTRAINT fk_punch_previous_checkout_staff_store
    FOREIGN KEY (previous_checkout_request_id, staff_id, store_id)
    REFERENCES public.correction_requests(id, staff_id, store_id),
  ADD CONSTRAINT punch_previous_checkout_shape
    CHECK (previous_checkout_request_id IS NULL OR event_type = 'CHECK_IN');
CREATE UNIQUE INDEX punch_previous_checkout_once
  ON public.punch_events(previous_checkout_request_id)
  WHERE previous_checkout_request_id IS NOT NULL;

-- A read-only hint, also rechecked by the punch transaction after locking the
-- state and request in the same order as manager decisions. It never resolves
-- an unknown time, closes an open break, or resets a shift at midnight.
CREATE FUNCTION public.staff_pending_shift_start(p_staff_id UUID)
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
      AND cr.requested_business_date = check_in.business_date
      AND cr.requested_occurred_at > latest.occurred_at AND cr.requested_occurred_at < NOW()
      AND NOT EXISTS (SELECT 1 FROM public.punch_events used
        WHERE used.previous_checkout_request_id = cr.id)
  )
  SELECT id, requested_occurred_at, candidates.business_date
  FROM candidates WHERE candidate_count = 1;
$$;
REVOKE ALL ON FUNCTION public.staff_pending_shift_start(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_pending_shift_start(UUID) TO onogami_app;

COMMIT;
