-- Separate product migration. Never run as part of attendance startup/deploy.
-- Apply with the migration owner in an isolated branch first.
BEGIN;

CREATE ROLE onogami_shift_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE SCHEMA shift;
REVOKE ALL ON SCHEMA shift FROM PUBLIC;
GRANT USAGE ON SCHEMA shift TO onogami_shift_app;

CREATE TABLE shift.periods (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.stores(id),
  unit text NOT NULL CHECK (unit IN ('month', 'week')),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  deadline timestamptz NOT NULL,
  timezone text NOT NULL,
  business_day_start_minute integer NOT NULL CHECK (business_day_start_minute BETWEEN 0 AND 1439),
  state text NOT NULL DEFAULT 'collecting' CHECK (state IN ('collecting', 'closed')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL,
  UNIQUE (id, store_id),
  UNIQUE (store_id, starts_on, ends_on),
  FOREIGN KEY (created_by, store_id) REFERENCES public.staff(id, store_id),
  CHECK ((unit = 'week' AND ends_on = starts_on + 6) OR
    (unit = 'month' AND starts_on = date_trunc('month', starts_on)::date
      AND ends_on = (starts_on + interval '1 month - 1 day')::date))
);

-- A manager cannot query drafts. Only request('self') for the verified actor can.
CREATE TABLE shift.drafts (
  period_id uuid NOT NULL,
  store_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  payload jsonb NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (period_id, staff_id),
  FOREIGN KEY (period_id, store_id) REFERENCES shift.periods(id, store_id),
  FOREIGN KEY (staff_id, store_id) REFERENCES public.staff(id, store_id)
);

CREATE TABLE shift.submissions (
  period_id uuid NOT NULL,
  store_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  payload jsonb NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  proxy boolean NOT NULL,
  submitted_by uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (period_id, staff_id),
  FOREIGN KEY (period_id, store_id) REFERENCES shift.periods(id, store_id),
  FOREIGN KEY (staff_id, store_id) REFERENCES public.staff(id, store_id),
  FOREIGN KEY (submitted_by, store_id) REFERENCES public.staff(id, store_id)
);

-- Immutable event/outbox foundation. No delivery worker or LINE sends in this phase.
CREATE TABLE shift.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL,
  period_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('submitted', 'proxy_submitted')),
  submission_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (period_id, recipient_id, submission_version),
  FOREIGN KEY (period_id, store_id) REFERENCES shift.periods(id, store_id),
  FOREIGN KEY (actor_id, store_id) REFERENCES public.staff(id, store_id),
  FOREIGN KEY (recipient_id, store_id) REFERENCES public.staff(id, store_id)
);

ALTER TABLE shift.periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift.drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift.submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift.events ENABLE ROW LEVEL SECURITY;
-- No runtime table policies or table grants: all operations use the scoped gateway.
REVOKE ALL ON ALL TABLES IN SCHEMA shift FROM PUBLIC, onogami_shift_app;

CREATE FUNCTION shift.valid_window(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE duration integer;
BEGIN
  IF jsonb_typeof(p->'nextDay') IS DISTINCT FROM 'boolean'
    OR coalesce(p->>'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    OR coalesce(p->>'end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN RETURN false; END IF;
  duration := (extract(epoch FROM (p->>'end')::time) - extract(epoch FROM (p->>'start')::time))::integer / 60
    + CASE WHEN (p->>'nextDay')::boolean THEN 1440 ELSE 0 END;
  RETURN duration > 0 AND duration <= 1440;
END; $$;

CREATE FUNCTION shift.validate_payload(p jsonb, p_start date, p_end date) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE b jsonb; item record; d date;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR octet_length(p::text) > 16384
    OR NOT (p ?& ARRAY['baseline','days']) OR p - ARRAY['baseline','days'] <> '{}'::jsonb
    THEN RAISE EXCEPTION 'SHIFT_INVALID_PAYLOAD'; END IF;
  b := p->'baseline';
  IF jsonb_typeof(b) IS DISTINCT FROM 'object'
    OR NOT (b ?& ARRAY['kind','weekdays','start','end','nextDay','target','targetUnit'])
    OR b - ARRAY['kind','weekdays','start','end','nextDay','target','targetUnit'] <> '{}'::jsonb
    OR coalesce(b->>'kind','') NOT IN ('fixed','variable') OR coalesce(b->>'targetUnit','') NOT IN ('week','month')
    OR jsonb_typeof(b->'weekdays') IS DISTINCT FROM 'array'
    OR jsonb_typeof(b->'target') IS DISTINCT FROM 'number'
    OR coalesce(b->>'target','') !~ '^[0-9]{1,2}$'
    OR NOT shift.valid_window(b) THEN RAISE EXCEPTION 'SHIFT_INVALID_PAYLOAD'; END IF;
  IF (b->>'target')::integer > (CASE WHEN b->>'targetUnit' = 'week' THEN 7 ELSE 31 END)
    OR jsonb_array_length(b->'weekdays') > 7
    OR (b->>'kind' = 'fixed' AND jsonb_array_length(b->'weekdays') = 0)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(b->'weekdays') w WHERE jsonb_typeof(w) <> 'number' OR w::text !~ '^[0-6]$')
    OR (SELECT count(*) <> count(DISTINCT w) FROM jsonb_array_elements(b->'weekdays') w)
    OR jsonb_typeof(p->'days') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'SHIFT_INVALID_PAYLOAD'; END IF;
  FOR item IN SELECT * FROM jsonb_each(p->'days') LOOP
    IF item.key !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'SHIFT_INVALID_PAYLOAD'; END IF;
    BEGIN d := item.key::date;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'SHIFT_INVALID_PAYLOAD'; END;
    IF d < p_start OR d > p_end OR jsonb_typeof(item.value) IS DISTINCT FROM 'object'
      OR coalesce(item.value->>'status','') NOT IN ('off','rest','available','want')
      OR item.value - ARRAY['status','start','end','nextDay'] <> '{}'::jsonb
      OR (item.value->>'status' <> 'off' AND NOT shift.valid_window(item.value))
      OR (item.value->>'status' = 'off' AND item.value <> '{"status":"off"}'::jsonb AND NOT shift.valid_window(item.value))
      THEN RAISE EXCEPTION 'SHIFT_INVALID_PAYLOAD'; END IF;
  END LOOP;
END; $$;

-- Run as the connection role before setting request context. Reject owner/attendance
-- credentials, including direct table or SECURITY DEFINER function grants.
CREATE FUNCTION shift.assert_runtime() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT pg_has_role(current_user, 'onogami_shift_app', 'USAGE')
    OR pg_has_role(current_user, 'onogami_app', 'MEMBER')
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls OR rolcreaterole))
    OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','shift') AND c.relkind IN ('r','p','v','m')
      AND (has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
    OR EXISTS (SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
      WHERE n.nspname='public' AND f.prosecdef AND has_function_privilege(current_user,f.oid,'EXECUTE'))
    THEN RAISE EXCEPTION 'SHIFT_UNSAFE_DATABASE_ROLE'; END IF;
END; $$;

-- Narrow shared identity projection; no attendance records, QR tokens or LINE IDs returned.
CREATE FUNCTION shift.actor() RETURNS TABLE (id uuid, store_id uuid, name text, manager boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT s.id, s.store_id, s.legal_name,
    s.role = 'MANAGER' OR EXISTS (SELECT 1 FROM public.staff_manager_access a
      WHERE a.staff_id=s.id AND a.store_id=s.store_id AND a.status='active')
  FROM public.staff s JOIN public.stores st ON st.id=s.store_id
  WHERE current_setting('shift.product',true)='shift'
    AND s.line_user_id=nullif(current_setting('shift.line_user_id',true),'')
    AND s.store_id::text=nullif(current_setting('shift.store_id',true),'')
    AND s.status='active' AND st.status='active'
$$;

CREATE FUNCTION shift.request(p_action text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a record; period shift.periods; target uuid; draft shift.drafts; submitted shift.submissions;
  result jsonb; value jsonb; next_version integer;
BEGIN
  SELECT * INTO a FROM shift.actor();
  IF a.id IS NULL THEN RAISE EXCEPTION 'SHIFT_FORBIDDEN'; END IF;
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR octet_length(p::text)>20000 THEN RAISE EXCEPTION 'SHIFT_INVALID_PAYLOAD'; END IF;
  IF p_action='bootstrap' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.starts_on DESC),'[]'::jsonb) INTO result
      FROM (SELECT * FROM shift.periods WHERE store_id=a.store_id ORDER BY starts_on DESC LIMIT 24) x;
    RETURN jsonb_build_object('actor',to_jsonb(a),'periods',result);
  ELSIF p_action='createPeriod' THEN
    IF NOT a.manager THEN RAISE EXCEPTION 'SHIFT_FORBIDDEN'; END IF;
    IF NOT (p ?& ARRAY['id','unit','startsOn','endsOn','deadline'])
      OR p->>'deadline' !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RAISE EXCEPTION 'SHIFT_INVALID_PAYLOAD'; END IF;
    INSERT INTO shift.periods(id,store_id,unit,starts_on,ends_on,deadline,timezone,business_day_start_minute,created_by)
      SELECT (p->>'id')::uuid,a.store_id,p->>'unit',(p->>'startsOn')::date,(p->>'endsOn')::date,
        (p->>'deadline')::timestamptz,s.timezone,s.business_day_start_minute,a.id FROM public.stores s WHERE s.id=a.store_id
      RETURNING * INTO period;
    IF period.deadline >= period.starts_on::timestamp AT TIME ZONE period.timezone THEN RAISE EXCEPTION 'SHIFT_INVALID_DEADLINE'; END IF;
    RETURN to_jsonb(period);
  END IF;
  -- Lock ordering is period first, then period/person. Closing waits for writes.
  IF p_action='closePeriod' THEN
    SELECT * INTO period FROM shift.periods WHERE id=(p->>'periodId')::uuid AND store_id=a.store_id FOR UPDATE;
  ELSE
    SELECT * INTO period FROM shift.periods WHERE id=(p->>'periodId')::uuid AND store_id=a.store_id FOR SHARE;
  END IF;
  IF period.id IS NULL THEN RAISE EXCEPTION 'SHIFT_FORBIDDEN'; END IF;
  IF p_action='manager' THEN
    IF NOT a.manager THEN RAISE EXCEPTION 'SHIFT_FORBIDDEN'; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.legal_name,'submitted',to_jsonb(sub)) ORDER BY s.legal_name,s.id),'[]'::jsonb)
      INTO result FROM public.staff s LEFT JOIN shift.submissions sub ON sub.staff_id=s.id AND sub.period_id=period.id AND sub.store_id=a.store_id
      WHERE s.store_id=a.store_id AND s.status='active';
    RETURN jsonb_build_object('period',to_jsonb(period),'people',result);
  ELSIF p_action='closePeriod' THEN
    IF NOT a.manager THEN RAISE EXCEPTION 'SHIFT_FORBIDDEN'; END IF;
    UPDATE shift.periods SET state='closed',version=version+1
      WHERE id=period.id AND version=(p->>'expectedVersion')::integer AND state='collecting' RETURNING * INTO period;
    IF NOT FOUND THEN RAISE EXCEPTION 'SHIFT_CONFLICT'; END IF;
    RETURN to_jsonb(period);
  END IF;
  target := a.id;
  IF p_action='proxySubmit' THEN
    IF NOT a.manager THEN RAISE EXCEPTION 'SHIFT_FORBIDDEN'; END IF;
    target := (p->>'staffId')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.staff WHERE id=target AND store_id=a.store_id AND status='active') THEN RAISE EXCEPTION 'SHIFT_FORBIDDEN'; END IF;
  END IF;
  IF p_action NOT IN ('self','saveDraft','submit','proxySubmit') THEN RAISE EXCEPTION 'SHIFT_INVALID_ACTION'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(period.id::text || target::text,0));
  -- Never load anyone else's private draft, even during a proxy submission.
  IF p_action <> 'proxySubmit' THEN SELECT * INTO draft FROM shift.drafts WHERE period_id=period.id AND staff_id=a.id AND store_id=a.store_id; END IF;
  SELECT * INTO submitted FROM shift.submissions WHERE period_id=period.id AND staff_id=target AND store_id=a.store_id;
  IF p_action='self' THEN RETURN jsonb_build_object('period',to_jsonb(period),'draft',to_jsonb(draft),'submitted',to_jsonb(submitted)); END IF;
  IF p_action <> 'proxySubmit' AND (period.state<>'collecting' OR clock_timestamp()>=period.deadline) THEN RAISE EXCEPTION 'SHIFT_CLOSED'; END IF;
  IF p_action IN ('saveDraft','submit') AND
    (p->>'expectedDraftVersion')::integer IS DISTINCT FROM coalesce(draft.version,0) THEN RAISE EXCEPTION 'SHIFT_CONFLICT'; END IF;
  IF p_action='saveDraft' THEN
    PERFORM shift.validate_payload(p->'payload',period.starts_on,period.ends_on);
    INSERT INTO shift.drafts(period_id,store_id,staff_id,payload,version)
      VALUES(period.id,a.store_id,a.id,p->'payload',coalesce(draft.version,0)+1)
      ON CONFLICT(period_id,staff_id) DO UPDATE SET payload=excluded.payload,version=excluded.version,updated_at=clock_timestamp()
      RETURNING * INTO draft;
    RETURN to_jsonb(draft);
  END IF;
  IF (p->>'expectedSubmissionVersion')::integer IS DISTINCT FROM coalesce(submitted.version,0) THEN RAISE EXCEPTION 'SHIFT_CONFLICT'; END IF;
  value := CASE WHEN p_action='proxySubmit' THEN p->'payload' ELSE draft.payload END;
  PERFORM shift.validate_payload(value,period.starts_on,period.ends_on);
  IF submitted.payload=value AND submitted.proxy=(p_action='proxySubmit') THEN RETURN to_jsonb(submitted); END IF;
  next_version := coalesce(submitted.version,0)+1;
  INSERT INTO shift.submissions(period_id,store_id,staff_id,payload,version,proxy,submitted_by)
    VALUES(period.id,a.store_id,target,value,next_version,p_action='proxySubmit',a.id)
    ON CONFLICT(period_id,staff_id) DO UPDATE SET payload=excluded.payload,version=excluded.version,proxy=excluded.proxy,
      submitted_by=excluded.submitted_by,submitted_at=clock_timestamp() RETURNING * INTO submitted;
  INSERT INTO shift.events(store_id,period_id,actor_id,recipient_id,kind,submission_version)
    VALUES(a.store_id,period.id,a.id,target,CASE WHEN p_action='proxySubmit' THEN 'proxy_submitted' ELSE 'submitted' END,next_version);
  RETURN to_jsonb(submitted);
END; $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA shift FROM PUBLIC, onogami_shift_app;
GRANT EXECUTE ON FUNCTION shift.assert_runtime(), shift.request(text,jsonb) TO onogami_shift_app;
COMMIT;
