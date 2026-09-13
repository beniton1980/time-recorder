DO $test$
DECLARE value jsonb; allowed boolean; i integer;
BEGIN
  BEGIN
    INSERT INTO public.stores(id,name) VALUES('10000000-0000-4000-8000-000000000011','SHIFT MEMBERSHIP FIXTURE');
    INSERT INTO public.staff(id,store_id,line_user_id,legal_name,role) VALUES('20000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000011','U_shift_membership_fixture','SHIFT MEMBERSHIP FIXTURE','STAFF');
    GRANT onogami_shift_runtime TO CURRENT_USER;
    SET LOCAL ROLE onogami_shift_runtime;
    PERFORM shift.assert_runtime();
    IF shift.memberships()<>'[]'::jsonb THEN RAISE EXCEPTION 'test failed: missing identity returns memberships'; END IF;
    PERFORM set_config('shift.product','shift',true);PERFORM set_config('shift.line_user_id','U_shift_membership_fixture',true);
    value:=shift.memberships();
    IF jsonb_array_length(value)<>1 OR value->0->>'storeId'<>'10000000-0000-4000-8000-000000000011' OR value::text LIKE '%line_user_id%' THEN RAISE EXCEPTION 'test failed: membership projection'; END IF;
    PERFORM set_config('shift.line_user_id','U_other_fixture',true);
    IF shift.memberships()<>'[]'::jsonb THEN RAISE EXCEPTION 'test failed: other identity leak'; END IF;
    BEGIN PERFORM 1 FROM shift.rate_limits LIMIT 1;RAISE EXCEPTION 'test failed: raw limiter table access';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
    FOR i IN 1..61 LOOP
      allowed:=shift.consume_limit('subject',repeat('b',64));
      IF allowed IS DISTINCT FROM (i<=60) THEN RAISE EXCEPTION 'test failed: fixed rate limit'; END IF;
    END LOOP;
    BEGIN PERFORM shift.consume_limit('unlimited',repeat('b',64));RAISE EXCEPTION 'test failed: configurable allowance';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'SHIFT_INVALID_REQUEST' THEN RAISE; END IF; END;
    RAISE SQLSTATE 'ZX001';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;
  END;
END;
$test$;
