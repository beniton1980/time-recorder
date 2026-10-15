BEGIN;

-- Keep submitted consultations and punch history intact. These two journals
-- record work on a consultation and its explicit completion separately.
CREATE TABLE public.consultation_corrections (
  request_id UUID NOT NULL,
  staff_id UUID NOT NULL,
  store_id UUID NOT NULL,
  correction_id UUID PRIMARY KEY,
  client_request_id UUID NOT NULL,
  payload JSONB NOT NULL,
  before_event JSONB,
  after_event JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (request_id, client_request_id),
  FOREIGN KEY (request_id, staff_id, store_id) REFERENCES public.correction_requests(id, staff_id, store_id),
  FOREIGN KEY (correction_id, staff_id, store_id) REFERENCES public.correction_requests(id, staff_id, store_id)
);
CREATE TABLE public.consultation_resolutions (
  request_id UUID PRIMARY KEY,
  staff_id UUID NOT NULL,
  store_id UUID NOT NULL,
  resolved_by UUID NOT NULL,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  outcome TEXT NOT NULL CHECK (outcome IN ('CORRECTED', 'NO_CHANGE')),
  reason TEXT CHECK (length(reason) BETWEEN 1 AND 500),
  CHECK (outcome <> 'NO_CHANGE' OR reason IS NOT NULL),
  FOREIGN KEY (request_id, staff_id, store_id) REFERENCES public.correction_requests(id, staff_id, store_id),
  FOREIGN KEY (resolved_by, store_id) REFERENCES public.staff(id, store_id)
);
CREATE INDEX consultation_resolutions_store_time ON public.consultation_resolutions(store_id, resolved_at DESC, request_id DESC);
ALTER TABLE public.consultation_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consultation_resolutions ENABLE ROW LEVEL SECURITY;
CREATE POLICY consultation_corrections_read ON public.consultation_corrections FOR SELECT TO onogami_app USING (
  public.app_request_setting('mode') IN ('operator', 'cron') OR public.app_manager_store_allowed(store_id)
  OR (public.app_request_setting('mode') = 'staff' AND public.app_actor_owns_staff(staff_id))
);
CREATE POLICY consultation_corrections_write ON public.consultation_corrections FOR INSERT TO onogami_app WITH CHECK (
  public.app_manager_store_allowed(store_id) AND public.app_manager_staff_allowed(staff_id)
);
CREATE POLICY consultation_resolutions_read ON public.consultation_resolutions FOR SELECT TO onogami_app USING (
  public.app_request_setting('mode') IN ('operator', 'cron') OR public.app_manager_store_allowed(store_id)
  OR (public.app_request_setting('mode') = 'staff' AND public.app_actor_owns_staff(staff_id))
);
CREATE POLICY consultation_resolutions_write ON public.consultation_resolutions FOR INSERT TO onogami_app WITH CHECK (
  public.app_manager_store_allowed(store_id) AND public.app_manager_staff_allowed(staff_id)
  AND EXISTS (SELECT 1 FROM public.staff st WHERE st.id = resolved_by AND st.store_id = consultation_resolutions.store_id
    AND st.line_user_id = public.app_request_setting('line_user_id') AND st.status = 'active')
);
REVOKE ALL ON public.consultation_corrections, public.consultation_resolutions FROM PUBLIC, onogami_app;
GRANT SELECT, INSERT ON public.consultation_corrections, public.consultation_resolutions TO onogami_app;

CREATE FUNCTION public.correction_request_status(p_id UUID) RETURNS TEXT
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN r.request_id IS NOT NULL THEN 'RESOLVED' ELSE cr.status END
  FROM public.correction_requests cr LEFT JOIN public.consultation_resolutions r ON r.request_id = cr.id
  WHERE cr.id = p_id
$$;

-- Also guard old clients/decision functions. Work already linked to a REVIEW
-- must not later turn that original consultation into an ADD or a rejection.
CREATE FUNCTION public.guard_consultation_decision() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.operation = 'REVIEW' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.operation IS DISTINCT FROM OLD.operation) THEN
    IF EXISTS (SELECT 1 FROM public.consultation_resolutions r WHERE r.request_id = OLD.id) THEN
      RAISE EXCEPTION 'REQUEST_NOT_PENDING';
    END IF;
    IF EXISTS (SELECT 1 FROM public.consultation_corrections c WHERE c.request_id = OLD.id) THEN
      RAISE EXCEPTION 'CONSULTATION_FLOW_REQUIRED';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard_consultation_decision BEFORE UPDATE ON public.correction_requests
FOR EACH ROW EXECUTE FUNCTION public.guard_consultation_decision();

CREATE FUNCTION public.apply_consultation_correction(
  p_store_id UUID, p_staff_id UUID, p_request_id UUID, p_client_request_id UUID,
  p_expected_version TEXT, p_operation TEXT, p_target_id UUID,
  p_event_type TEXT, p_occurred_at TIMESTAMPTZ, p_reason TEXT
) RETURNS TABLE(id UUID, operation TEXT, status TEXT)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  current_version TEXT;
  consultation public.correction_requests%ROWTYPE;
  saved public.consultation_corrections%ROWTYPE;
  target public.effective_punch_events%ROWTYPE;
  created_id UUID;
  intent JSONB;
  before_value JSONB;
  after_value JSONB;
BEGIN
  IF NOT COALESCE(public.app_manager_store_allowed(p_store_id), FALSE)
    OR NOT COALESCE(public.app_manager_staff_allowed(p_staff_id), FALSE) THEN RAISE EXCEPTION 'MANAGER_ACCESS_REQUIRED'; END IF;
  IF p_client_request_id IS NULL OR p_expected_version IS NULL THEN RAISE EXCEPTION 'INVALID_CORRECTION'; END IF;
  SELECT extract(epoch FROM ss.updated_at)::text INTO current_version FROM public.staff_states ss
  JOIN public.staff st ON st.id = ss.staff_id WHERE ss.staff_id = p_staff_id AND st.store_id = p_store_id FOR UPDATE OF ss;
  IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_STATE_NOT_FOUND'; END IF;
  SELECT cr.* INTO consultation FROM public.correction_requests cr
  WHERE cr.id = p_request_id AND cr.staff_id = p_staff_id AND cr.store_id = p_store_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONSULTATION_NOT_FOUND'; END IF;
  intent := jsonb_build_object('version', p_expected_version, 'operation', p_operation, 'target', p_target_id,
    'type', p_event_type, 'at', p_occurred_at, 'reason', p_reason);
  SELECT c.* INTO saved FROM public.consultation_corrections c
  WHERE c.request_id = p_request_id AND c.client_request_id = p_client_request_id;
  IF FOUND THEN
    IF saved.payload IS DISTINCT FROM intent THEN RAISE EXCEPTION 'CLIENT_REQUEST_CONFLICT'; END IF;
    RETURN QUERY SELECT saved.correction_id, p_operation, 'APPROVED'::text;
    RETURN;
  END IF;
  IF consultation.operation <> 'REVIEW' OR public.correction_request_status(p_request_id) <> 'PENDING'
    OR consultation.group_id IS NOT NULL THEN RAISE EXCEPTION 'REQUEST_NOT_PENDING'; END IF;
  IF current_version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'ATTENDANCE_CHANGED'; END IF;
  IF p_operation IN ('REPLACE','VOID') THEN
    SELECT e.* INTO target FROM public.effective_punch_events e
    WHERE e.effective_id = p_target_id AND e.staff_id = p_staff_id AND e.store_id = p_store_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'TARGET_NOT_FOUND'; END IF;
    before_value := jsonb_build_object('id', target.effective_id, 'type', target.event_type,
      'at', target.occurred_at, 'day', target.business_date);
  ELSIF p_operation IS DISTINCT FROM 'ADD' OR p_target_id IS NOT NULL THEN RAISE EXCEPTION 'INVALID_CORRECTION'; END IF;
  SELECT result.correction_id INTO created_id FROM public.apply_manager_direct_correction(
    p_store_id, p_staff_id, p_operation, target.original_event_id, target.origin_correction_id,
    p_event_type, p_occurred_at, p_reason) result;
  SELECT jsonb_build_object('id', e.effective_id, 'type', e.event_type, 'at', e.occurred_at, 'day', e.business_date)
  INTO after_value FROM public.effective_punch_events e
  WHERE e.effective_id = COALESCE(p_target_id, created_id) AND e.staff_id = p_staff_id AND e.store_id = p_store_id;
  INSERT INTO public.consultation_corrections(request_id, staff_id, store_id, correction_id,
    client_request_id, payload, before_event, after_event)
  VALUES (p_request_id, p_staff_id, p_store_id, created_id, p_client_request_id, intent, before_value, after_value);
  RETURN QUERY SELECT created_id, p_operation, 'APPROVED'::text;
END
$$;

CREATE FUNCTION public.resolve_consultation(p_store_id UUID, p_request_id UUID, p_expected_version TEXT, p_reason TEXT)
RETURNS TABLE(request_id UUID, outcome TEXT, resolved_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  consultation public.correction_requests%ROWTYPE;
  saved public.consultation_resolutions%ROWTYPE;
  current_version TEXT;
  manager_id UUID;
  result_outcome TEXT;
BEGIN
  IF NOT COALESCE(public.app_manager_store_allowed(p_store_id), FALSE) THEN RAISE EXCEPTION 'MANAGER_ACCESS_REQUIRED'; END IF;
  SELECT cr.* INTO consultation FROM public.correction_requests cr WHERE cr.id = p_request_id AND cr.store_id = p_store_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONSULTATION_NOT_FOUND'; END IF;
  SELECT extract(epoch FROM ss.updated_at)::text INTO current_version FROM public.staff_states ss
  WHERE ss.staff_id = consultation.staff_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_STATE_NOT_FOUND'; END IF;
  SELECT cr.* INTO consultation FROM public.correction_requests cr WHERE cr.id = p_request_id FOR UPDATE;
  SELECT r.* INTO saved FROM public.consultation_resolutions r WHERE r.request_id = p_request_id;
  IF FOUND THEN RETURN QUERY SELECT saved.request_id, saved.outcome, saved.resolved_at; RETURN; END IF;
  IF consultation.operation <> 'REVIEW' OR consultation.status <> 'PENDING' OR consultation.group_id IS NOT NULL THEN
    RAISE EXCEPTION 'REQUEST_NOT_PENDING'; END IF;
  IF p_expected_version IS NULL OR current_version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'ATTENDANCE_CHANGED'; END IF;
  result_outcome := CASE WHEN EXISTS (SELECT 1 FROM public.consultation_corrections c WHERE c.request_id = p_request_id)
    THEN 'CORRECTED' ELSE 'NO_CHANGE' END;
  IF (result_outcome = 'NO_CHANGE' AND NULLIF(btrim(p_reason), '') IS NULL) OR length(p_reason) > 500 THEN
    RAISE EXCEPTION 'RESOLUTION_REASON_REQUIRED'; END IF;
  SELECT st.id INTO manager_id FROM public.staff st WHERE st.store_id = p_store_id
    AND st.line_user_id = public.app_request_setting('line_user_id') AND st.status = 'active' ORDER BY st.created_at LIMIT 1;
  INSERT INTO public.consultation_resolutions(request_id, staff_id, store_id, resolved_by, outcome, reason)
  VALUES (p_request_id, consultation.staff_id, p_store_id, manager_id, result_outcome, NULLIF(btrim(p_reason), ''))
  RETURNING * INTO saved;
  RETURN QUERY SELECT saved.request_id, saved.outcome, saved.resolved_at;
END
$$;

REVOKE ALL ON FUNCTION public.correction_request_status(UUID), public.guard_consultation_decision(),
  public.apply_consultation_correction(UUID,UUID,UUID,UUID,TEXT,TEXT,UUID,TEXT,TIMESTAMPTZ,TEXT),
  public.resolve_consultation(UUID,UUID,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.correction_request_status(UUID),
  public.apply_consultation_correction(UUID,UUID,UUID,UUID,TEXT,TEXT,UUID,TEXT,TIMESTAMPTZ,TEXT),
  public.resolve_consultation(UUID,UUID,TEXT,TEXT) TO onogami_app;
COMMIT;
