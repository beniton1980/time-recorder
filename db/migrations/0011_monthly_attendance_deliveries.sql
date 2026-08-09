BEGIN;

CREATE TABLE monthly_attendance_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  delivery_version TEXT NOT NULL DEFAULT 'initial',
  status TEXT NOT NULL DEFAULT 'PROCESSING'
    CHECK (status IN ('PROCESSING', 'SENT', 'FAILED')),
  recipient TEXT NOT NULL,
  provider_email_id TEXT,
  last_error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (store_id, period_start, period_end, delivery_version),
  CHECK (period_start <= period_end),
  CHECK (status <> 'SENT' OR sent_at IS NOT NULL)
);

CREATE INDEX idx_monthly_attendance_deliveries_status
  ON monthly_attendance_deliveries(status, updated_at);

COMMIT;

