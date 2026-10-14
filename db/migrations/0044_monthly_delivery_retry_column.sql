-- Qualify the column that conflicts with the delivery_id OUT parameter.
-- Keep the signature, SECURITY DEFINER settings, existing ownership and grants.
BEGIN;

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

    UPDATE public.monthly_attendance_delivery_attempts AS stale_attempt
    SET status = 'FAILED',
        error_code = 'STALE_DELIVERY_RECOVERED',
        finished_at = NOW()
    WHERE stale_attempt.delivery_id = claimed_delivery_id
      AND stale_attempt.status = 'PROCESSING';

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

COMMIT;
