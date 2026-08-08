ALTER TABLE correction_requests
  ADD COLUMN IF NOT EXISTS target_correction_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_correction_requests_target_correction'
      AND conrelid = 'correction_requests'::regclass
  ) THEN
    ALTER TABLE correction_requests
      ADD CONSTRAINT fk_correction_requests_target_correction
      FOREIGN KEY (target_correction_id)
      REFERENCES correction_requests(id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_correction_requests_target_correction
  ON correction_requests(target_correction_id);

CREATE OR REPLACE VIEW effective_punch_events AS
WITH latest_original_modifiers AS (
  SELECT DISTINCT ON (cr.target_event_id)
    cr.id,
    cr.target_event_id,
    cr.operation,
    cr.requested_event_type,
    cr.requested_occurred_at,
    cr.approved_at
  FROM correction_requests cr
  WHERE cr.status = 'APPROVED'
    AND cr.operation IN ('REPLACE', 'VOID')
    AND cr.target_event_id IS NOT NULL
  ORDER BY
    cr.target_event_id,
    cr.approved_at DESC NULLS LAST,
    cr.requested_at DESC,
    cr.id DESC
),
latest_addition_modifiers AS (
  SELECT DISTINCT ON (cr.target_correction_id)
    cr.id,
    cr.target_correction_id,
    cr.operation,
    cr.requested_event_type,
    cr.requested_occurred_at,
    cr.approved_at
  FROM correction_requests cr
  WHERE cr.status = 'APPROVED'
    AND cr.operation IN ('REPLACE', 'VOID')
    AND cr.target_correction_id IS NOT NULL
  ORDER BY
    cr.target_correction_id,
    cr.approved_at DESC NULLS LAST,
    cr.requested_at DESC,
    cr.id DESC
),
effective_originals AS (
  SELECT
    pe.id AS effective_id,
    pe.id AS original_event_id,
    lm.id AS correction_request_id,
    pe.store_id,
    pe.staff_id,
    COALESCE(lm.requested_event_type, pe.event_type) AS event_type,
    COALESCE(lm.requested_occurred_at, pe.occurred_at) AS occurred_at,
    CASE
      WHEN lm.operation = 'REPLACE'
        AND lm.requested_occurred_at IS NOT NULL
      THEN (
        (
          lm.requested_occurred_at AT TIME ZONE s.timezone
        ) - make_interval(mins => s.business_day_start_minute)
      )::date
      ELSE pe.business_date
    END AS business_date,
    pe.latitude,
    pe.longitude,
    pe.gps_accuracy_m,
    pe.distance_from_store_m,
    pe.location_status,
    pe.validation_status,
    pe.validation_code,
    pe.source,
    pe.created_at,
    (lm.operation = 'REPLACE') AS corrected,
    NULL::uuid AS origin_correction_id
  FROM punch_events pe
  JOIN stores s ON s.id = pe.store_id
  LEFT JOIN latest_original_modifiers lm
    ON lm.target_event_id = pe.id
  WHERE lm.operation IS DISTINCT FROM 'VOID'
),
effective_additions AS (
  SELECT
    addition.id AS effective_id,
    NULL::uuid AS original_event_id,
    COALESCE(lm.id, addition.id) AS correction_request_id,
    addition.store_id,
    addition.staff_id,
    COALESCE(lm.requested_event_type, addition.requested_event_type) AS event_type,
    COALESCE(lm.requested_occurred_at, addition.requested_occurred_at) AS occurred_at,
    (
      (
        COALESCE(
          lm.requested_occurred_at,
          addition.requested_occurred_at
        ) AT TIME ZONE s.timezone
      ) - make_interval(mins => s.business_day_start_minute)
    )::date AS business_date,
    NULL::double precision AS latitude,
    NULL::double precision AS longitude,
    NULL::double precision AS gps_accuracy_m,
    NULL::double precision AS distance_from_store_m,
    'UNAVAILABLE'::text AS location_status,
    'WARNING'::text AS validation_status,
    CASE
      WHEN lm.operation = 'REPLACE'
        THEN 'APPROVED_CORRECTION_REPLACE'
      ELSE 'APPROVED_CORRECTION_ADD'
    END::text AS validation_code,
    'CORRECTION'::text AS source,
    addition.created_at,
    TRUE AS corrected,
    addition.id AS origin_correction_id
  FROM correction_requests addition
  JOIN stores s ON s.id = addition.store_id
  LEFT JOIN latest_addition_modifiers lm
    ON lm.target_correction_id = addition.id
  WHERE addition.status = 'APPROVED'
    AND addition.operation = 'ADD'
    AND addition.requested_event_type IS NOT NULL
    AND addition.requested_occurred_at IS NOT NULL
    AND lm.operation IS DISTINCT FROM 'VOID'
)
SELECT * FROM effective_originals
UNION ALL
SELECT * FROM effective_additions;
