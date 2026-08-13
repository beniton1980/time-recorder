CREATE TABLE IF NOT EXISTS api_rate_limits (
  scope text NOT NULL,
  fingerprint_hash text NOT NULL CHECK (fingerprint_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (scope, fingerprint_hash)
);

CREATE OR REPLACE FUNCTION consume_api_rate_limit(
  p_scope text,
  p_fingerprint_hash text,
  p_limit integer,
  p_window_seconds integer
)
RETURNS TABLE (allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
AS $$
DECLARE
  current_row api_rate_limits%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_scope IS NULL OR length(p_scope) < 1
    OR p_fingerprint_hash !~ '^[0-9a-f]{64}$'
    OR p_limit < 1 OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'INVALID_RATE_LIMIT_POLICY';
  END IF;

  INSERT INTO api_rate_limits (scope, fingerprint_hash, window_started_at, request_count)
  VALUES (p_scope, p_fingerprint_hash, v_now, 1)
  ON CONFLICT (scope, fingerprint_hash) DO UPDATE SET
    window_started_at = CASE
      WHEN api_rate_limits.window_started_at + make_interval(secs => p_window_seconds) <= v_now
      THEN v_now ELSE api_rate_limits.window_started_at END,
    request_count = CASE
      WHEN api_rate_limits.window_started_at + make_interval(secs => p_window_seconds) <= v_now
      THEN 1 ELSE api_rate_limits.request_count + 1 END
  RETURNING * INTO current_row;

  allowed := current_row.request_count <= p_limit;
  retry_after_seconds := GREATEST(
    1,
    CEIL(EXTRACT(EPOCH FROM (
      current_row.window_started_at + make_interval(secs => p_window_seconds) - v_now
    )))::integer
  );

  IF random() < 0.01 THEN
    DELETE FROM api_rate_limits
    WHERE window_started_at < v_now - interval '2 days';
  END IF;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON TABLE api_rate_limits FROM PUBLIC;
REVOKE ALL ON FUNCTION consume_api_rate_limit(text, text, integer, integer) FROM PUBLIC;
