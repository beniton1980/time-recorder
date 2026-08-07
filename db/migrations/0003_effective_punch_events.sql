CREATE OR REPLACE VIEW effective_punch_events AS
WITH latest_target_corrections AS (
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
effective_originals AS (
  SELECT
    pe.id AS effective_id,
    pe.id AS original_event_id,
    lc.id AS correction_request_id,
    pe.store_id,
    pe.staff_id,
    COALESCE(lc.requested_event_type, pe.event_type) AS event_type,
    COALESCE(lc.requested_occurred_at, pe.occurred_at) AS occurred_at,
    CASE
      WHEN lc.operation = 'REPLACE'
        AND lc.requested_occurred_at IS NOT NULL
      THEN (
        (
          lc.requested_occurred_at AT TIME ZONE s.timezone
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
    (lc.operation = 'REPLACE') AS corrected
  FROM punch_events pe
  JOIN stores s ON s.id = pe.store_id
  LEFT JOIN latest_target_corrections lc
    ON lc.target_event_id = pe.id
  WHERE lc.operation IS DISTINCT FROM 'VOID'
),
approved_additions AS (
  SELECT
    cr.id AS effective_id,
    NULL::uuid AS original_event_id,
    cr.id AS correction_request_id,
    cr.store_id,
    cr.staff_id,
    cr.requested_event_type AS event_type,
    cr.requested_occurred_at AS occurred_at,
    (
      (
        cr.requested_occurred_at AT TIME ZONE s.timezone
      ) - make_interval(mins => s.business_day_start_minute)
    )::date AS business_date,
    NULL::double precision AS latitude,
    NULL::double precision AS longitude,
    NULL::double precision AS gps_accuracy_m,
    NULL::double precision AS distance_from_store_m,
    'UNAVAILABLE'::text AS location_status,
    'WARNING'::text AS validation_status,
    'APPROVED_CORRECTION_ADD'::text AS validation_code,
    'CORRECTION'::text AS source,
    cr.created_at,
    TRUE AS corrected
  FROM correction_requests cr
  JOIN stores s ON s.id = cr.store_id
  WHERE cr.status = 'APPROVED'
    AND cr.operation = 'ADD'
    AND cr.requested_event_type IS NOT NULL
    AND cr.requested_occurred_at IS NOT NULL
)
SELECT * FROM effective_originals
UNION ALL
SELECT * FROM approved_additions;
