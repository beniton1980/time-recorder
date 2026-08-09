BEGIN;

CREATE TABLE onboarding_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_request_id UUID NOT NULL UNIQUE,
  business_name TEXT NOT NULL,
  store_name TEXT NOT NULL,
  manager_legal_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  store_address TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  business_day_start_minute INTEGER NOT NULL DEFAULT 300
    CHECK (business_day_start_minute >= 0 AND business_day_start_minute < 1440),
  closing_rule TEXT NOT NULL DEFAULT 'month_end'
    CHECK (closing_rule IN ('month_end', 'day_15', 'day_25')),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'PROVISIONED')),
  terms_accepted_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by_line_user_id TEXT,
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  provisioned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'PENDING' AND reviewed_at IS NULL AND reviewed_by_line_user_id IS NULL)
    OR
    (status <> 'PENDING' AND reviewed_at IS NOT NULL AND reviewed_by_line_user_id IS NOT NULL)
  ),
  CHECK (status <> 'REJECTED' OR rejection_reason IS NOT NULL),
  CHECK (status <> 'PROVISIONED' OR provisioned_at IS NOT NULL)
);

CREATE INDEX idx_onboarding_requests_status_submitted
  ON onboarding_requests(status, submitted_at);

COMMIT;
