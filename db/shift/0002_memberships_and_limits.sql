BEGIN;

CREATE FUNCTION shift.memberships() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('storeId',s.store_id,'storeName',st.name,'staffId',s.id,'name',s.legal_name,
    'manager',s.role='MANAGER' OR EXISTS (SELECT 1 FROM public.staff_manager_access a
      WHERE a.store_id=s.store_id AND a.staff_id=s.id AND a.status='active')) ORDER BY st.name,s.store_id),'[]'::jsonb)
  FROM public.staff s JOIN public.stores st ON st.id=s.store_id
  WHERE current_setting('shift.product',true)='shift' AND s.status='active' AND st.status='active'
    AND s.line_user_id=nullif(current_setting('shift.line_user_id',true),'')
$$;
REVOKE ALL ON FUNCTION shift.memberships() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shift.memberships() TO onogami_shift_app;

CREATE TABLE shift.rate_limits (
  bucket text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL
);
ALTER TABLE shift.rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON shift.rate_limits FROM PUBLIC, onogami_shift_app;

-- Fixed limits; callers cannot choose their own allowance. Short-lived HMAC
-- fingerprints only. Always consume global first to bound unauthenticated growth.
CREATE FUNCTION shift.consume_limit(p_scope text,p_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_window timestamptz:=date_trunc('minute',clock_timestamp()); count_used integer; ceiling integer;
BEGIN
  IF p_scope NOT IN ('global','client','subject') OR p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'SHIFT_INVALID_REQUEST'; END IF;
  ceiling:=CASE p_scope WHEN 'global' THEN 1800 WHEN 'client' THEN 180 ELSE 60 END;
  INSERT INTO shift.rate_limits(bucket,window_start,hits) VALUES(p_scope||':'||p_key,current_window,1)
  ON CONFLICT(bucket) DO UPDATE SET window_start=excluded.window_start,
    hits=CASE WHEN rate_limits.window_start=excluded.window_start THEN least(rate_limits.hits+1,ceiling+1) ELSE 1 END
  RETURNING hits INTO count_used;
  DELETE FROM shift.rate_limits WHERE window_start<current_window-interval '2 minutes';
  RETURN count_used<=ceiling;
END;
$$;
REVOKE ALL ON FUNCTION shift.consume_limit(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shift.consume_limit(text,text) TO onogami_shift_app;
COMMIT;
