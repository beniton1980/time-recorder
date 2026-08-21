BEGIN;

ALTER TABLE public.stores
  ADD COLUMN monthly_report_email_verification_token_hash TEXT,
  ADD COLUMN monthly_report_email_verification_expires_at TIMESTAMPTZ,
  ADD COLUMN monthly_report_email_verification_sent_at TIMESTAMPTZ,
  ADD COLUMN monthly_report_email_verified_at TIMESTAMPTZ,
  ADD COLUMN monthly_report_email_consented_at TIMESTAMPTZ,
  ADD COLUMN monthly_report_email_consent_version TEXT,
  ADD COLUMN monthly_report_email_updated_by_staff_id UUID
    REFERENCES public.staff(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX uq_stores_monthly_report_email_verification_token_hash
  ON public.stores(monthly_report_email_verification_token_hash)
  WHERE monthly_report_email_verification_token_hash IS NOT NULL;

ALTER TABLE public.stores
  ADD CONSTRAINT stores_monthly_report_email_verification_pair
  CHECK (
    (monthly_report_email_verification_token_hash IS NULL)
    = (monthly_report_email_verification_expires_at IS NULL)
  ),
  ADD CONSTRAINT stores_monthly_report_email_consent_pair
  CHECK (
    (monthly_report_email_consented_at IS NULL)
    = (monthly_report_email_consent_version IS NULL)
  ),
  ADD CONSTRAINT stores_monthly_report_email_confirmation_complete
  CHECK (
    (monthly_report_email_verified_at IS NULL)
    = (monthly_report_email_consented_at IS NULL)
  );

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
BEGIN
  IF NOT public.app_manager_store_allowed(p_store_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MANAGER_ACCESS_REQUIRED';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stores store
    WHERE store.id = p_store_id
      AND lower(store.monthly_report_email) = lower(btrim(p_email))
      AND store.monthly_report_email_verified_at IS NOT NULL
      AND store.monthly_report_email_consented_at IS NOT NULL
      AND store.monthly_report_email_consent_version = '2026-08-21-v1'
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
BEGIN
  IF NOT public.app_manager_store_allowed(p_store_id) THEN
    RETURN FALSE;
  END IF;

  UPDATE public.stores
  SET monthly_report_email_verification_sent_at = NOW(),
      updated_at = NOW()
  WHERE id = p_store_id
    AND monthly_report_email_verification_token_hash = p_token_hash;

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
BEGIN
  IF p_consent_version <> '2026-08-21-v1' THEN
    RETURN FALSE;
  END IF;

  UPDATE public.stores
  SET monthly_report_email_verified_at = NOW(),
      monthly_report_email_consented_at = NOW(),
      monthly_report_email_consent_version = p_consent_version,
      monthly_report_email_verification_token_hash = NULL,
      monthly_report_email_verification_expires_at = NULL,
      updated_at = NOW()
  WHERE id = p_store_id
    AND monthly_report_email IS NOT NULL
    AND monthly_report_email_verification_token_hash = p_token_hash
    AND monthly_report_email_verification_expires_at > NOW()
    AND monthly_report_email_verified_at IS NULL
    AND monthly_report_email_consented_at IS NULL;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.set_monthly_report_recipient(UUID, TEXT, TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_monthly_report_verification_sent(UUID, TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_monthly_report_recipient(UUID, TEXT, TEXT)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.set_monthly_report_recipient(UUID, TEXT, TEXT)
  TO onogami_app;
GRANT EXECUTE ON FUNCTION public.mark_monthly_report_verification_sent(UUID, TEXT)
  TO onogami_app;
GRANT EXECUTE ON FUNCTION public.confirm_monthly_report_recipient(UUID, TEXT, TEXT)
  TO onogami_app;

COMMIT;
