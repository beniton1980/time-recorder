BEGIN;

ALTER TABLE public.onboarding_requests
  ADD COLUMN business_category TEXT,
  ADD COLUMN staff_count_range TEXT,
  ADD COLUMN store_count_range TEXT,
  ADD COLUMN prior_attendance_method TEXT,
  ADD COLUMN reported_acquisition_source TEXT;

ALTER TABLE public.stores
  ADD COLUMN business_category TEXT,
  ADD COLUMN staff_count_range TEXT,
  ADD COLUMN store_count_range TEXT,
  ADD COLUMN prior_attendance_method TEXT,
  ADD COLUMN reported_acquisition_source TEXT;

ALTER TABLE public.onboarding_requests
  ADD CONSTRAINT onboarding_business_category_allowed
    CHECK (business_category IS NULL OR business_category IN (
      'food_service', 'retail', 'personal_services', 'lodging',
      'medical_welfare', 'education', 'construction', 'manufacturing', 'other'
    )),
  ADD CONSTRAINT onboarding_staff_count_range_allowed
    CHECK (staff_count_range IS NULL OR staff_count_range IN (
      '1_4', '5_9', '10_19', '20_49', '50_plus'
    )),
  ADD CONSTRAINT onboarding_store_count_range_allowed
    CHECK (store_count_range IS NULL OR store_count_range IN (
      '1', '2_4', '5_9', '10_plus'
    )),
  ADD CONSTRAINT onboarding_prior_attendance_method_allowed
    CHECK (prior_attendance_method IS NULL OR prior_attendance_method IN (
      'paper', 'spreadsheet', 'time_clock', 'other_service', 'none', 'other'
    )),
  ADD CONSTRAINT onboarding_reported_acquisition_source_allowed
    CHECK (reported_acquisition_source IS NULL OR reported_acquisition_source IN (
      'referral', 'business_group', 'web_search', 'social_media', 'event', 'other'
    ));

ALTER TABLE public.stores
  ADD CONSTRAINT stores_business_category_allowed
    CHECK (business_category IS NULL OR business_category IN (
      'food_service', 'retail', 'personal_services', 'lodging',
      'medical_welfare', 'education', 'construction', 'manufacturing', 'other'
    )),
  ADD CONSTRAINT stores_staff_count_range_allowed
    CHECK (staff_count_range IS NULL OR staff_count_range IN (
      '1_4', '5_9', '10_19', '20_49', '50_plus'
    )),
  ADD CONSTRAINT stores_store_count_range_allowed
    CHECK (store_count_range IS NULL OR store_count_range IN (
      '1', '2_4', '5_9', '10_plus'
    )),
  ADD CONSTRAINT stores_prior_attendance_method_allowed
    CHECK (prior_attendance_method IS NULL OR prior_attendance_method IN (
      'paper', 'spreadsheet', 'time_clock', 'other_service', 'none', 'other'
    )),
  ADD CONSTRAINT stores_reported_acquisition_source_allowed
    CHECK (reported_acquisition_source IS NULL OR reported_acquisition_source IN (
      'referral', 'business_group', 'web_search', 'social_media', 'event', 'other'
    ));

CREATE OR REPLACE FUNCTION public.provision_onboarding_request(
  p_request_id UUID,
  p_token_hash TEXT,
  p_operator_line_user_id TEXT
)
RETURNS TABLE (
  store_id UUID,
  store_name TEXT,
  invite_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  request_row public.onboarding_requests%ROWTYPE;
  new_store_id UUID;
  new_expires_at TIMESTAMPTZ := NOW() + INTERVAL '7 days';
BEGIN
  SELECT *
  INTO request_row
  FROM public.onboarding_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ONBOARDING_REQUEST_NOT_FOUND';
  END IF;

  IF request_row.status = 'PROVISIONED'
     OR request_row.provisioned_store_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ONBOARDING_REQUEST_ALREADY_PROVISIONED';
  END IF;

  IF request_row.status <> 'APPROVED' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ONBOARDING_REQUEST_NOT_APPROVED';
  END IF;

  INSERT INTO public.stores (
    name,
    timezone,
    business_day_start_minute,
    closing_rule,
    status,
    business_category,
    staff_count_range,
    store_count_range,
    prior_attendance_method,
    reported_acquisition_source
  )
  VALUES (
    request_row.store_name,
    request_row.timezone,
    request_row.business_day_start_minute,
    request_row.closing_rule,
    'suspended',
    request_row.business_category,
    request_row.staff_count_range,
    request_row.store_count_range,
    request_row.prior_attendance_method,
    request_row.reported_acquisition_source
  )
  RETURNING id INTO new_store_id;

  INSERT INTO public.onboarding_manager_invites (
    onboarding_request_id,
    store_id,
    token_hash,
    expires_at,
    created_by_line_user_id
  )
  VALUES (
    request_row.id,
    new_store_id,
    p_token_hash,
    new_expires_at,
    p_operator_line_user_id
  );

  UPDATE public.onboarding_requests
  SET
    status = 'PROVISIONED',
    provisioned_at = NOW(),
    provisioned_store_id = new_store_id,
    updated_at = NOW()
  WHERE id = request_row.id;

  RETURN QUERY
  SELECT new_store_id, request_row.store_name, new_expires_at;
END;
$$;

COMMIT;
