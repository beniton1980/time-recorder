BEGIN;

CREATE TABLE public.monthly_report_recipient_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id),
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  email TEXT NOT NULL CHECK (length(btrim(email)) > 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'REVOKED')),
  verification_token_hash TEXT,
  verification_expires_at TIMESTAMPTZ,
  verification_sent_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  consented_at TIMESTAMPTZ,
  consent_version TEXT,
  requested_by_staff_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (store_id, version_number),
  UNIQUE (verification_token_hash),
  CHECK ((verification_token_hash IS NULL) = (verification_expires_at IS NULL)),
  CHECK ((consented_at IS NULL) = (consent_version IS NULL)),
  CHECK ((verified_at IS NULL) = (consented_at IS NULL)),
  CHECK (status <> 'CONFIRMED' OR (verified_at IS NOT NULL AND consented_at IS NOT NULL)),
  CHECK (status <> 'REVOKED' OR revoked_at IS NOT NULL)
);

ALTER TABLE public.stores
  ADD COLUMN monthly_report_recipient_version_id UUID
    REFERENCES public.monthly_report_recipient_versions(id);

INSERT INTO public.monthly_report_recipient_versions (
  store_id,
  version_number,
  email,
  status,
  verification_token_hash,
  verification_expires_at,
  verification_sent_at,
  verified_at,
  consented_at,
  consent_version,
  requested_by_staff_id
)
SELECT
  id,
  1,
  monthly_report_email,
  CASE
    WHEN monthly_report_email_verified_at IS NOT NULL
      AND monthly_report_email_consented_at IS NOT NULL
      AND monthly_report_email_consent_version = '2026-08-21-v1'
    THEN 'CONFIRMED'
    ELSE 'PENDING'
  END,
  monthly_report_email_verification_token_hash,
  monthly_report_email_verification_expires_at,
  monthly_report_email_verification_sent_at,
  monthly_report_email_verified_at,
  monthly_report_email_consented_at,
  monthly_report_email_consent_version,
  monthly_report_email_updated_by_staff_id
FROM public.stores
WHERE monthly_report_email IS NOT NULL;

UPDATE public.stores store
SET monthly_report_recipient_version_id = version.id
FROM public.monthly_report_recipient_versions version
WHERE version.store_id = store.id
  AND version.version_number = 1;

ALTER TABLE public.monthly_attendance_deliveries
  ADD COLUMN initial_recipient_version_id UUID
    REFERENCES public.monthly_report_recipient_versions(id);

CREATE TABLE public.monthly_attendance_delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES public.monthly_attendance_deliveries(id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  recipient_version_id UUID NOT NULL REFERENCES public.monthly_report_recipient_versions(id),
  recipient TEXT NOT NULL CHECK (length(btrim(recipient)) > 0),
  status TEXT NOT NULL DEFAULT 'PROCESSING'
    CHECK (status IN ('PROCESSING', 'SENT', 'FAILED')),
  provider_email_id TEXT,
  error_code TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  UNIQUE (delivery_id, attempt_number),
  CHECK ((status = 'PROCESSING') = (finished_at IS NULL))
);

CREATE INDEX idx_monthly_report_recipient_versions_store
  ON public.monthly_report_recipient_versions(store_id, version_number DESC);
CREATE INDEX idx_monthly_attendance_delivery_attempts_processing
  ON public.monthly_attendance_delivery_attempts(recipient_version_id, started_at)
  WHERE status = 'PROCESSING';

ALTER TABLE public.monthly_report_recipient_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monthly_attendance_delivery_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.monthly_report_recipient_versions FROM PUBLIC;
REVOKE ALL ON TABLE public.monthly_attendance_delivery_attempts FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.set_monthly_report_recipient(
  p_store_id UUID,
  p_email TEXT,
  p_token_hash TEXT
)
RETURNS TABLE (
  store_name TEXT,
  recipient TEXT,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  manager_staff_id UUID;
  current_version_id UUID;
  next_version_number INTEGER;
  new_version_id UUID;
BEGIN
  IF NOT public.app_manager_store_allowed(p_store_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MANAGER_ACCESS_REQUIRED';
  END IF;

  PERFORM 1 FROM public.stores WHERE id = p_store_id FOR UPDATE;

  SELECT store.monthly_report_recipient_version_id
  INTO current_version_id
  FROM public.stores store
  WHERE store.id = p_store_id;

  IF current_version_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.monthly_attendance_delivery_attempts attempt
    WHERE attempt.recipient_version_id = current_version_id
      AND attempt.status = 'PROCESSING'
      AND attempt.started_at >= NOW() - INTERVAL '15 minutes'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MONTHLY_REPORT_DELIVERY_IN_PROGRESS';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.monthly_report_recipient_versions version
    WHERE version.id = current_version_id
      AND lower(version.email) = lower(btrim(p_email))
      AND version.status = 'CONFIRMED'
      AND version.consent_version = '2026-08-21-v1'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MONTHLY_REPORT_RECIPIENT_ALREADY_CONFIRMED';
  END IF;

  SELECT manager.id
  INTO manager_staff_id
  FROM public.staff manager
  WHERE manager.store_id = p_store_id
    AND manager.line_user_id = public.app_request_setting('line_user_id')
    AND manager.role = 'MANAGER'
    AND manager.status = 'active'
  ORDER BY manager.created_at ASC
  LIMIT 1;

  SELECT COALESCE(MAX(version.version_number), 0) + 1
  INTO next_version_number
  FROM public.monthly_report_recipient_versions version
  WHERE version.store_id = p_store_id;

  UPDATE public.monthly_report_recipient_versions
  SET status = 'REVOKED',
      verification_token_hash = NULL,
      verification_expires_at = NULL,
      revoked_at = NOW()
  WHERE id = current_version_id
    AND status <> 'REVOKED';

  INSERT INTO public.monthly_report_recipient_versions (
    store_id,
    version_number,
    email,
    status,
    verification_token_hash,
    verification_expires_at,
    requested_by_staff_id
  ) VALUES (
    p_store_id,
    next_version_number,
    btrim(p_email),
    'PENDING',
    p_token_hash,
    NOW() + INTERVAL '24 hours',
    manager_staff_id
  )
  RETURNING id INTO new_version_id;

  RETURN QUERY
  UPDATE public.stores store
  SET monthly_report_email = btrim(p_email),
      monthly_report_email_verification_token_hash = p_token_hash,
      monthly_report_email_verification_expires_at = NOW() + INTERVAL '24 hours',
      monthly_report_email_verification_sent_at = NULL,
      monthly_report_email_verified_at = NULL,
      monthly_report_email_consented_at = NULL,
      monthly_report_email_consent_version = NULL,
      monthly_report_email_updated_by_staff_id = manager_staff_id,
      monthly_report_recipient_version_id = new_version_id,
      updated_at = NOW()
  WHERE store.id = p_store_id
  RETURNING
    store.name,
    store.monthly_report_email,
    store.monthly_report_email_verification_expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_monthly_report_verification_sent(
  p_store_id UUID,
  p_token_hash TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  version_id UUID;
BEGIN
  IF NOT public.app_manager_store_allowed(p_store_id) THEN
    RETURN FALSE;
  END IF;

  SELECT store.monthly_report_recipient_version_id
  INTO version_id
  FROM public.stores store
  WHERE store.id = p_store_id;

  UPDATE public.monthly_report_recipient_versions
  SET verification_sent_at = NOW()
  WHERE id = version_id
    AND status = 'PENDING'
    AND verification_token_hash = p_token_hash;

  IF NOT FOUND THEN RETURN FALSE; END IF;

  UPDATE public.stores
  SET monthly_report_email_verification_sent_at = NOW(),
      updated_at = NOW()
  WHERE id = p_store_id
    AND monthly_report_recipient_version_id = version_id;

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_monthly_report_recipient(
  p_store_id UUID,
  p_token_hash TEXT,
  p_consent_version TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  version_id UUID;
BEGIN
  IF p_consent_version <> '2026-08-21-v1' THEN
    RETURN FALSE;
  END IF;

  SELECT store.monthly_report_recipient_version_id
  INTO version_id
  FROM public.stores store
  WHERE store.id = p_store_id
  FOR UPDATE;

  UPDATE public.monthly_report_recipient_versions
  SET status = 'CONFIRMED',
      verified_at = NOW(),
      consented_at = NOW(),
      consent_version = p_consent_version,
      verification_token_hash = NULL,
      verification_expires_at = NULL
  WHERE id = version_id
    AND status = 'PENDING'
    AND verification_token_hash = p_token_hash
    AND verification_expires_at > NOW();

  IF NOT FOUND THEN RETURN FALSE; END IF;

  UPDATE public.stores
  SET monthly_report_email_verified_at = NOW(),
      monthly_report_email_consented_at = NOW(),
      monthly_report_email_consent_version = p_consent_version,
      monthly_report_email_verification_token_hash = NULL,
      monthly_report_email_verification_expires_at = NULL,
      updated_at = NOW()
  WHERE id = p_store_id
    AND monthly_report_recipient_version_id = version_id;

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_monthly_attendance_delivery(
  p_store_id UUID,
  p_period_start DATE,
  p_period_end DATE,
  p_delivery_version TEXT,
  p_recipient_version_id UUID
)
RETURNS TABLE (
  delivery_id UUID,
  attempt_id UUID,
  recipient TEXT,
  attempt_number INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  recipient_row public.monthly_report_recipient_versions%ROWTYPE;
  claimed_delivery_id UUID;
  next_attempt INTEGER;
  new_attempt_id UUID;
BEGIN
  IF public.app_request_setting('mode') IS DISTINCT FROM 'cron'
    AND NOT public.app_manager_store_allowed(p_store_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'DELIVERY_ACCESS_REQUIRED';
  END IF;

  IF p_period_start > p_period_end
    OR length(p_delivery_version) = 0
    OR length(p_delivery_version) > 128 THEN
    RETURN;
  END IF;

  PERFORM 1 FROM public.stores WHERE id = p_store_id FOR UPDATE;

  SELECT version.*
  INTO recipient_row
  FROM public.monthly_report_recipient_versions version
  JOIN public.stores store
    ON store.id = version.store_id
   AND store.monthly_report_recipient_version_id = version.id
  WHERE version.id = p_recipient_version_id
    AND version.store_id = p_store_id
    AND version.status = 'CONFIRMED'
    AND version.verified_at IS NOT NULL
    AND version.consented_at IS NOT NULL
    AND version.consent_version = '2026-08-21-v1';

  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO public.monthly_attendance_deliveries (
    store_id,
    period_start,
    period_end,
    delivery_version,
    recipient,
    initial_recipient_version_id
  ) VALUES (
    p_store_id,
    p_period_start,
    p_period_end,
    p_delivery_version,
    recipient_row.email,
    recipient_row.id
  )
  ON CONFLICT (store_id, period_start, period_end, delivery_version)
  DO NOTHING
  RETURNING id INTO claimed_delivery_id;

  IF claimed_delivery_id IS NULL THEN
    SELECT delivery.id
    INTO claimed_delivery_id
    FROM public.monthly_attendance_deliveries delivery
    WHERE delivery.store_id = p_store_id
      AND delivery.period_start = p_period_start
      AND delivery.period_end = p_period_end
      AND delivery.delivery_version = p_delivery_version
    FOR UPDATE;

    IF NOT FOUND THEN RETURN; END IF;

    IF EXISTS (
      SELECT 1
      FROM public.monthly_attendance_deliveries delivery
      WHERE delivery.id = claimed_delivery_id
        AND (
          delivery.status = 'SENT'
          OR (
            delivery.status = 'PROCESSING'
            AND delivery.updated_at >= NOW() - INTERVAL '15 minutes'
          )
        )
    ) THEN
      RETURN;
    END IF;

    UPDATE public.monthly_attendance_delivery_attempts
    SET status = 'FAILED',
        error_code = 'STALE_DELIVERY_RECOVERED',
        finished_at = NOW()
    WHERE delivery_id = claimed_delivery_id
      AND status = 'PROCESSING';

    UPDATE public.monthly_attendance_deliveries
    SET status = 'PROCESSING',
        provider_email_id = NULL,
        last_error_code = NULL,
        sent_at = NULL,
        attempt_count = attempt_count + 1,
        updated_at = NOW()
    WHERE id = claimed_delivery_id;
  END IF;

  SELECT COALESCE(MAX(attempt.attempt_number), 0) + 1
  INTO next_attempt
  FROM public.monthly_attendance_delivery_attempts attempt
  WHERE attempt.delivery_id = claimed_delivery_id;

  INSERT INTO public.monthly_attendance_delivery_attempts (
    delivery_id,
    attempt_number,
    recipient_version_id,
    recipient
  ) VALUES (
    claimed_delivery_id,
    next_attempt,
    recipient_row.id,
    recipient_row.email
  )
  RETURNING id INTO new_attempt_id;

  RETURN QUERY SELECT claimed_delivery_id, new_attempt_id, recipient_row.email, next_attempt;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_monthly_attendance_delivery_attempt(
  p_attempt_id UUID,
  p_succeeded BOOLEAN,
  p_provider_email_id TEXT,
  p_error_code TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_delivery_id UUID;
  target_store_id UUID;
BEGIN
  SELECT attempt.delivery_id, delivery.store_id
  INTO target_delivery_id, target_store_id
  FROM public.monthly_attendance_delivery_attempts attempt
  JOIN public.monthly_attendance_deliveries delivery ON delivery.id = attempt.delivery_id
  WHERE attempt.id = p_attempt_id
    AND attempt.status = 'PROCESSING'
  FOR UPDATE OF attempt, delivery;

  IF NOT FOUND THEN RETURN FALSE; END IF;

  IF public.app_request_setting('mode') IS DISTINCT FROM 'cron'
    AND NOT public.app_manager_store_allowed(target_store_id) THEN
    RETURN FALSE;
  END IF;

  UPDATE public.monthly_attendance_delivery_attempts
  SET status = CASE WHEN p_succeeded THEN 'SENT' ELSE 'FAILED' END,
      provider_email_id = CASE WHEN p_succeeded THEN p_provider_email_id ELSE NULL END,
      error_code = CASE WHEN p_succeeded THEN NULL ELSE p_error_code END,
      finished_at = NOW()
  WHERE id = p_attempt_id;

  UPDATE public.monthly_attendance_deliveries
  SET status = CASE WHEN p_succeeded THEN 'SENT' ELSE 'FAILED' END,
      provider_email_id = CASE WHEN p_succeeded THEN p_provider_email_id ELSE NULL END,
      last_error_code = CASE WHEN p_succeeded THEN NULL ELSE p_error_code END,
      sent_at = CASE WHEN p_succeeded THEN NOW() ELSE NULL END,
      updated_at = NOW()
  WHERE id = target_delivery_id;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_monthly_attendance_delivery(UUID, DATE, DATE, TEXT, UUID)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_monthly_attendance_delivery_attempt(UUID, BOOLEAN, TEXT, TEXT)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.claim_monthly_attendance_delivery(UUID, DATE, DATE, TEXT, UUID)
  TO onogami_app;
GRANT EXECUTE ON FUNCTION public.finish_monthly_attendance_delivery_attempt(UUID, BOOLEAN, TEXT, TEXT)
  TO onogami_app;

COMMIT;
