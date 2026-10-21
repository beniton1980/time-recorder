BEGIN;

-- Navigation provenance only. Original requests, their business-day rules and
-- the effective attendance view remain unchanged.
CREATE TABLE public.correction_attention_sources (
  request_id UUID PRIMARY KEY,
  staff_id UUID NOT NULL,
  store_id UUID NOT NULL,
  source_event_id UUID,
  source_correction_id UUID,
  source_reference JSONB NOT NULL,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (num_nonnulls(source_event_id, source_correction_id) = 1),
  FOREIGN KEY (request_id, staff_id, store_id) REFERENCES public.correction_requests(id, staff_id, store_id),
  FOREIGN KEY (source_event_id, staff_id, store_id) REFERENCES public.punch_events(id, staff_id, store_id),
  FOREIGN KEY (source_correction_id, staff_id, store_id) REFERENCES public.correction_requests(id, staff_id, store_id)
);
CREATE INDEX correction_attention_sources_work ON public.correction_attention_sources
  (staff_id, store_id, (source_reference->>'eventId'));
ALTER TABLE public.correction_attention_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY correction_attention_sources_read ON public.correction_attention_sources FOR SELECT TO onogami_app USING (
  public.app_manager_store_allowed(store_id)
  OR (public.app_request_setting('mode') = 'staff' AND public.app_actor_owns_staff(staff_id) AND public.app_token_store_allowed(store_id)
    AND EXISTS (SELECT 1 FROM public.staff st WHERE st.id = correction_attention_sources.staff_id AND st.status = 'active'))
);
CREATE POLICY correction_attention_sources_write ON public.correction_attention_sources FOR INSERT TO onogami_app WITH CHECK (
  public.app_request_setting('mode') = 'staff' AND public.app_actor_owns_staff(staff_id) AND public.app_token_store_allowed(store_id)
    AND EXISTS (SELECT 1 FROM public.staff st WHERE st.id = correction_attention_sources.staff_id AND st.status = 'active')
);
REVOKE ALL ON public.correction_attention_sources FROM PUBLIC, onogami_app;
GRANT SELECT, INSERT ON public.correction_attention_sources TO onogami_app;

-- A minimal snapshot of this person's retained events, grouped by the SSoT's
-- business day. No names, GPS or manager-only data. No recent-event limit.
CREATE FUNCTION public.staff_attention_days(p_store_id UUID, p_staff_id UUID)
RETURNS TABLE(source JSONB, events JSONB)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  WITH scoped AS MATERIALIZED (
    SELECT e.effective_id, e.original_event_id, e.origin_correction_id, e.correction_request_id,
      e.staff_id, e.store_id, e.business_date, e.event_type, e.occurred_at
    FROM public.effective_punch_events e
    WHERE e.store_id = p_store_id AND e.staff_id = p_staff_id
      AND public.app_request_setting('mode') = 'staff'
      AND public.app_actor_owns_staff(p_staff_id) AND public.app_token_store_allowed(p_store_id)
      AND EXISTS (SELECT 1 FROM public.staff st WHERE st.id = p_staff_id AND st.status = 'active')
  ), days AS (
    SELECT business_date, jsonb_agg(to_jsonb(e) ORDER BY occurred_at, effective_id) AS events
    FROM scoped e GROUP BY business_date
  )
  SELECT jsonb_build_object('eventId', anchor.effective_id, 'revision', md5(days.events::text),
    'businessDate', days.business_date, 'startedAt', anchor.occurred_at,
    'originalEventId', anchor.original_event_id, 'originCorrectionId', anchor.origin_correction_id,
    'lastType', last_event.event_type, 'lastAt', last_event.occurred_at,
    'breakStartedAt', CASE WHEN last_event.event_type = 'BREAK_START' THEN last_event.occurred_at END,
    'current', ss.state <> 'OFF_DUTY' AND last_event.effective_id = latest.effective_id,
    'today', ((NOW() AT TIME ZONE s.timezone) - make_interval(mins => s.business_day_start_minute))::date,
    'canCorrect', anchor.occurred_at >= NOW() - interval '62 days'), days.events
  FROM days JOIN public.stores s ON s.id = p_store_id
  JOIN public.staff_states ss ON ss.staff_id = p_staff_id
  CROSS JOIN LATERAL (SELECT * FROM scoped e WHERE e.business_date = days.business_date
    ORDER BY (e.event_type = 'CHECK_IN') DESC, e.occurred_at DESC, e.effective_id DESC LIMIT 1) anchor
  CROSS JOIN LATERAL (SELECT * FROM scoped e WHERE e.business_date = days.business_date
    ORDER BY e.occurred_at DESC, e.effective_id DESC LIMIT 1) last_event
  CROSS JOIN LATERAL (SELECT effective_id FROM scoped ORDER BY occurred_at DESC, effective_id DESC LIMIT 1) latest
$$;

CREATE FUNCTION public.submit_staff_correction_with_source(
  p_store_id UUID, p_staff_id UUID, p_client_request_id UUID, p_category TEXT,
  p_target_event_id UUID, p_expected_revision_id UUID, p_event_type TEXT,
  p_occurred_at TIMESTAMPTZ, p_reason TEXT, p_break_ended_at TIMESTAMPTZ, p_source JSONB
) RETURNS TABLE(result_status TEXT, correction_request JSONB)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  existing public.correction_requests%ROWTYPE;
  context JSONB;
  saved RECORD;
  previous_source JSONB;
  check_in UUID;
BEGIN
  IF public.app_request_setting('mode') IS DISTINCT FROM 'staff' OR NOT COALESCE(public.app_actor_owns_staff(p_staff_id), FALSE)
    OR NOT COALESCE(public.app_token_store_allowed(p_store_id), FALSE) THEN RAISE EXCEPTION 'STAFF_OR_STORE_NOT_FOUND'; END IF;
  -- Same lock order as punches, approvals and consultation completion.
  PERFORM 1 FROM public.staff_states ss JOIN public.staff st ON st.id = ss.staff_id
    WHERE ss.staff_id = p_staff_id AND st.store_id = p_store_id AND st.status = 'active' FOR UPDATE OF ss;
  IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_OR_STORE_NOT_FOUND'; END IF;
  SELECT cr.* INTO existing FROM public.correction_requests cr
    WHERE cr.staff_id = p_staff_id AND cr.store_id = p_store_id AND cr.client_request_id = p_client_request_id;
  IF FOUND THEN
    SELECT c.source_reference INTO previous_source FROM public.correction_attention_sources c WHERE c.request_id = existing.id;
    IF previous_source IS DISTINCT FROM p_source THEN RAISE EXCEPTION 'CLIENT_REQUEST_CONFLICT'; END IF;
    -- Delegate exact payload comparison and legacy replay before checking staleness.
    RETURN QUERY SELECT * FROM public.submit_staff_correction(p_store_id, p_staff_id, p_client_request_id,
      p_category, p_target_event_id, p_expected_revision_id, p_event_type, p_occurred_at, p_reason, p_break_ended_at);
    RETURN;
  END IF;
  IF p_source IS NOT NULL THEN
    SELECT d.source INTO context FROM public.staff_attention_days(p_store_id, p_staff_id) d
      WHERE d.source->>'eventId' = p_source->>'eventId' AND d.source->>'revision' = p_source->>'revision';
    IF context IS NULL THEN RAISE EXCEPTION 'ATTENTION_CHANGED'; END IF;
    IF p_source IS DISTINCT FROM jsonb_build_object('eventId', context->>'eventId', 'revision', context->>'revision')
      OR p_category NOT IN ('MISSED', 'OTHER') THEN RAISE EXCEPTION 'INVALID_CORRECTION_REQUEST'; END IF;
    -- Existing requests for the same work take precedence, even from another tab.
    SELECT cr.* INTO existing FROM public.correction_requests cr
      LEFT JOIN public.correction_attention_sources link ON link.request_id = cr.id
      WHERE cr.staff_id = p_staff_id AND cr.store_id = p_store_id
        AND public.correction_request_status(cr.id) = 'PENDING'
        AND (link.source_reference->>'eventId' = context->>'eventId'
          OR (link.request_id IS NULL AND cr.operation = 'ADD' AND cr.requested_event_type IN ('CHECK_OUT', 'BREAK_END')
            AND cr.requested_occurred_at > (context->>'startedAt')::timestamptz
            AND (SELECT e.effective_id FROM public.effective_punch_events e WHERE e.staff_id = p_staff_id
              AND e.store_id = p_store_id AND e.event_type = 'CHECK_IN' AND e.occurred_at <= cr.requested_occurred_at
              ORDER BY e.occurred_at DESC, e.effective_id DESC LIMIT 1)::text = context->>'eventId'))
        AND (cr.operation = 'REVIEW' OR
          (cr.requested_event_type = 'CHECK_OUT' AND context->>'lastType' <> 'BREAK_START') OR
          (cr.requested_event_type = 'BREAK_END' AND context->>'lastType' = 'BREAK_START'
            AND COALESCE((link.snapshot->>'breakStartedAt')::timestamptz, (
              SELECT e.occurred_at FROM public.effective_punch_events e WHERE e.staff_id = p_staff_id AND e.store_id = p_store_id
                AND e.event_type = 'BREAK_START' AND e.occurred_at < cr.requested_occurred_at
                ORDER BY e.occurred_at DESC, e.effective_id DESC LIMIT 1)) = (context->>'breakStartedAt')::timestamptz))
      ORDER BY cr.requested_at, cr.id LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT 'existing'::text, jsonb_build_object('id', existing.id, 'status', 'PENDING'); RETURN;
    END IF;
    IF p_category = 'MISSED' THEN
      SELECT e.effective_id INTO check_in FROM public.effective_punch_events e
        WHERE e.staff_id = p_staff_id AND e.store_id = p_store_id AND e.event_type = 'CHECK_IN' AND e.occurred_at <= p_occurred_at
        ORDER BY e.occurred_at DESC, e.effective_id DESC LIMIT 1;
      IF check_in::text IS DISTINCT FROM context->>'eventId' OR p_occurred_at <= (context->>'startedAt')::timestamptz
        OR p_event_type IS DISTINCT FROM (CASE WHEN context->>'lastType' = 'BREAK_START' THEN 'BREAK_END' ELSE 'CHECK_OUT' END)
        OR context->>'lastType' = 'CHECK_OUT' THEN RAISE EXCEPTION 'ATTENTION_CHANGED'; END IF;
    END IF;
  END IF;
  SELECT * INTO saved FROM public.submit_staff_correction(p_store_id, p_staff_id, p_client_request_id,
    p_category, p_target_event_id, p_expected_revision_id, p_event_type, p_occurred_at, p_reason, p_break_ended_at);
  IF p_source IS NOT NULL THEN
    INSERT INTO public.correction_attention_sources(request_id, staff_id, store_id, source_event_id, source_correction_id, source_reference, snapshot)
    VALUES ((saved.correction_request->>'id')::uuid, p_staff_id, p_store_id,
      (context->>'originalEventId')::uuid, (context->>'originCorrectionId')::uuid, p_source,
      context - 'today' - 'current' - 'canCorrect' - 'originalEventId' - 'originCorrectionId');
  END IF;
  RETURN QUERY SELECT saved.result_status, saved.correction_request;
END
$$;
REVOKE ALL ON FUNCTION public.staff_attention_days(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_staff_correction_with_source(UUID, UUID, UUID, TEXT, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_attention_days(UUID, UUID) TO onogami_app;
GRANT EXECUTE ON FUNCTION public.submit_staff_correction_with_source(UUID, UUID, UUID, TEXT, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, JSONB) TO onogami_app;
COMMIT;
