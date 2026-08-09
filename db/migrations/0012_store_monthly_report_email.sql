BEGIN;

ALTER TABLE stores
  ADD COLUMN monthly_report_email TEXT;

UPDATE stores s
SET monthly_report_email = (
  SELECT r.contact_email
  FROM onboarding_requests r
  WHERE r.provisioned_store_id = s.id
  ORDER BY r.created_at DESC
  LIMIT 1
)
WHERE s.monthly_report_email IS NULL
  AND EXISTS (
    SELECT 1
    FROM onboarding_requests r
    WHERE r.provisioned_store_id = s.id
  );

ALTER TABLE stores
  ADD CONSTRAINT stores_monthly_report_email_not_blank
  CHECK (monthly_report_email IS NULL OR btrim(monthly_report_email) <> '');

COMMIT;
