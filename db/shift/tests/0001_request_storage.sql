-- Run ONLY in an isolated migrated branch, as migration owner. Fictional fixtures
-- and context changes are rolled back by the caught ZX001 subtransaction below.
DO $test$
DECLARE
  store_a uuid := '10000000-0000-4000-8000-000000000001';
  store_b uuid := '10000000-0000-4000-8000-000000000002';
  manager_id uuid := '20000000-0000-4000-8000-000000000001';
  staff_id uuid := '20000000-0000-4000-8000-000000000002';
  other_id uuid := '20000000-0000-4000-8000-000000000003';
  delegate_id uuid := '20000000-0000-4000-8000-000000000004';
  period_id uuid := '30000000-0000-4000-8000-000000000001';
  payload jsonb := '{"baseline":{"kind":"variable","weekdays":[],"start":"17:00","end":"22:00","nextDay":false,"target":2,"targetUnit":"week"},"days":{}}';
  command jsonb; result jsonb; invalid jsonb;
BEGIN
  BEGIN
    -- Test runner needs SET ROLE only for this rolled-back fixture transaction.
    GRANT onogami_shift_app TO CURRENT_USER;
    INSERT INTO public.stores(id,name) VALUES (store_a,'SHIFT FIXTURE A'),(store_b,'SHIFT FIXTURE B');
    INSERT INTO public.staff(id,store_id,line_user_id,legal_name,role) VALUES
      (manager_id,store_a,'U_shift_fixture_manager','SHIFT FIXTURE MANAGER','MANAGER'),
      (staff_id,store_a,'U_shift_fixture_staff','SHIFT FIXTURE STAFF','STAFF'),
      (other_id,store_b,'U_shift_fixture_other','SHIFT FIXTURE OTHER','STAFF'),
      (delegate_id,store_a,'U_shift_fixture_delegate','SHIFT FIXTURE DELEGATE','STAFF');
    INSERT INTO public.staff_manager_access(store_id,staff_id,granted_by_staff_id) VALUES(store_a,delegate_id,manager_id);

    BEGIN PERFORM shift.assert_runtime(); RAISE EXCEPTION 'test failed: owner role accepted';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'SHIFT_UNSAFE_DATABASE_ROLE' THEN RAISE; END IF; END;
    PERFORM set_config('role','onogami_shift_app',true);
    PERFORM shift.assert_runtime();
    BEGIN PERFORM 1 FROM public.punch_events LIMIT 1; RAISE EXCEPTION 'test failed: attendance read'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN PERFORM 1 FROM public.staff LIMIT 1; RAISE EXCEPTION 'test failed: raw identity read'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN PERFORM 1 FROM shift.drafts LIMIT 1; RAISE EXCEPTION 'test failed: raw draft read'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN PERFORM shift.request('bootstrap','{}'); RAISE EXCEPTION 'test failed: missing context';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'SHIFT_FORBIDDEN' THEN RAISE; END IF; END;
    PERFORM set_config('shift.product','shift',true);
    PERFORM set_config('shift.store_id',store_a::text,true);
    PERFORM set_config('shift.line_user_id','U_shift_fixture_manager',true);
    result := shift.request('createPeriod',jsonb_build_object('id',period_id,'unit','month','startsOn','2099-10-01','endsOn','2099-10-31','deadline','2099-09-25T20:00:00+09:00'));
    IF result->>'timezone' <> 'Asia/Tokyo' OR result->>'business_day_start_minute' <> '300' THEN RAISE EXCEPTION 'test failed: shared store settings'; END IF;

    PERFORM set_config('shift.line_user_id','U_shift_fixture_staff',true);
    command := jsonb_build_object('periodId',period_id,'expectedDraftVersion',0,'payload',payload);
    result := shift.request('saveDraft',command);
    IF result->>'version' <> '1' THEN RAISE EXCEPTION 'test failed: draft save'; END IF;
    BEGIN PERFORM shift.request('saveDraft',command); RAISE EXCEPTION 'test failed: stale draft overwrite';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'SHIFT_CONFLICT' THEN RAISE; END IF; END;
    BEGIN PERFORM shift.request('manager',command); RAISE EXCEPTION 'test failed: staff manager access';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'SHIFT_FORBIDDEN' THEN RAISE; END IF; END;
    BEGIN PERFORM shift.request('proxySubmit',command); RAISE EXCEPTION 'test failed: staff proxy access';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'SHIFT_FORBIDDEN' THEN RAISE; END IF; END;

    FOR invalid IN SELECT * FROM jsonb_array_elements(jsonb_build_array(
      jsonb_set(payload,'{baseline,kind}','null'),
      jsonb_set(payload,'{baseline,target}','8'),
      jsonb_set(payload,'{baseline,weekdays}','[1,1]'),
      jsonb_set(payload,'{baseline,end}','"17:00"'),
      jsonb_set(payload,'{days}','{"2099-11-01":{"status":"off"}}'),
      jsonb_set(payload,'{days}','{"2099-10-02":{"status":"available","start":"22:00","end":"03:00","nextDay":false}}'),
      jsonb_set(payload,'{days}','{"2099-10-02":{"status":"unknown"}}'),
      payload || '{"privateReason":"must not store"}'::jsonb
    )) LOOP
      BEGIN PERFORM shift.request('saveDraft',command || jsonb_build_object('expectedDraftVersion',1,'payload',invalid)); RAISE EXCEPTION 'test failed: invalid payload accepted';
      EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'SHIFT_INVALID_PAYLOAD' THEN RAISE; END IF; END;
    END LOOP;

    PERFORM set_config('shift.line_user_id','U_shift_fixture_manager',true);
    result := shift.request('manager',command);
    IF result::text LIKE '%baseline%' OR result::text LIKE '%draft%' THEN RAISE EXCEPTION 'test failed: private draft leaked'; END IF;
    result := shift.request('self',command || jsonb_build_object('staffId',staff_id));
    IF result::text LIKE '%baseline%' THEN RAISE EXCEPTION 'test failed: claimed staff ID leaked draft'; END IF;
    PERFORM set_config('shift.line_user_id','U_shift_fixture_other',true);
    BEGIN PERFORM shift.request('self',command); RAISE EXCEPTION 'test failed: foreign store context';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'SHIFT_FORBIDDEN' THEN RAISE; END IF; END;
    PERFORM set_config('shift.store_id',store_b::text,true);
    BEGIN PERFORM shift.request('self',command); RAISE EXCEPTION 'test failed: foreign period';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'SHIFT_FORBIDDEN' THEN RAISE; END IF; END;

    PERFORM set_config('shift.store_id',store_a::text,true);
    PERFORM set_config('shift.line_user_id','U_shift_fixture_staff',true);
    command := jsonb_build_object('periodId',period_id,'expectedDraftVersion',1,'expectedSubmissionVersion',0);
    result := shift.request('submit',command);
    IF result->>'version' <> '1' OR result->>'proxy' <> 'false' OR result->'payload' <> payload THEN RAISE EXCEPTION 'test failed: submission snapshot'; END IF;
    BEGIN PERFORM shift.request('submit',command); RAISE EXCEPTION 'test failed: stale submit retry';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'SHIFT_CONFLICT' THEN RAISE; END IF; END;
    result := shift.request('submit',command || '{"expectedSubmissionVersion":1}');
    IF result->>'version' <> '1' THEN RAISE EXCEPTION 'test failed: unchanged submission duplicated'; END IF;

    PERFORM set_config('shift.line_user_id','U_shift_fixture_delegate',true);
    result := shift.request('manager',command);
    IF result::text NOT LIKE '%baseline%' OR result::text LIKE '%draft%' THEN RAISE EXCEPTION 'test failed: delegated manager submitted view'; END IF;
    result := shift.request('proxySubmit',command || jsonb_build_object('staffId',staff_id,'expectedSubmissionVersion',1,'payload',jsonb_set(payload,'{baseline,target}','3')));
    IF result->>'version' <> '2' OR result->>'proxy' <> 'true' THEN RAISE EXCEPTION 'test failed: proxy submit'; END IF;
    BEGIN PERFORM shift.request('proxySubmit',command || jsonb_build_object('staffId',other_id,'payload',payload)); RAISE EXCEPTION 'test failed: cross-store proxy';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'SHIFT_FORBIDDEN' THEN RAISE; END IF; END;

    PERFORM set_config('shift.line_user_id','U_shift_fixture_staff',true);
    result := shift.request('self',command);
    IF result->'draft'->'payload' <> payload OR result->'submitted'->>'version' <> '2' THEN RAISE EXCEPTION 'test failed: proxy overwrote draft'; END IF;
    BEGIN PERFORM shift.request('submit',command || '{"expectedSubmissionVersion":1}'); RAISE EXCEPTION 'test failed: stale submit overwrote proxy';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'SHIFT_CONFLICT' THEN RAISE; END IF; END;

    PERFORM set_config('shift.line_user_id','U_shift_fixture_manager',true);
    PERFORM shift.request('closePeriod',command || '{"expectedVersion":1}');
    PERFORM set_config('shift.line_user_id','U_shift_fixture_staff',true);
    BEGIN PERFORM shift.request('submit',command || '{"expectedSubmissionVersion":2}'); RAISE EXCEPTION 'test failed: closed period accepted';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'SHIFT_CLOSED' THEN RAISE; END IF; END;
    PERFORM set_config('shift.line_user_id','U_shift_fixture_manager',true);
    result := shift.request('proxySubmit',command || jsonb_build_object('staffId',staff_id,'expectedSubmissionVersion',2,'payload',payload));
    IF result->>'version' <> '3' THEN RAISE EXCEPTION 'test failed: proxy after closing'; END IF;
    PERFORM shift.request('createPeriod',jsonb_build_object('id','30000000-0000-4000-8000-000000000002','unit','week','startsOn','2020-01-06','endsOn','2020-01-12','deadline','2020-01-01T20:00:00+09:00'));
    PERFORM set_config('shift.line_user_id','U_shift_fixture_staff',true);
    BEGIN PERFORM shift.request('saveDraft',jsonb_build_object('periodId','30000000-0000-4000-8000-000000000002','expectedDraftVersion',0,'payload',payload)); RAISE EXCEPTION 'test failed: server deadline ignored';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'SHIFT_CLOSED' THEN RAISE; END IF; END;

    PERFORM set_config('role','none',true);
    IF (SELECT count(*) FROM shift.events WHERE store_id=store_a) <> 3 THEN RAISE EXCEPTION 'test failed: event count'; END IF;
    UPDATE public.staff SET status='inactive' WHERE id=staff_id;
    PERFORM set_config('role','onogami_shift_app',true);
    BEGIN PERFORM shift.request('self',command); RAISE EXCEPTION 'test failed: inactive membership';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'SHIFT_FORBIDDEN' THEN RAISE; END IF; END;
    RAISE SQLSTATE 'ZX001' USING MESSAGE='all shift storage assertions passed; rollback fictional fixtures';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;
  END;
END;
$test$;
