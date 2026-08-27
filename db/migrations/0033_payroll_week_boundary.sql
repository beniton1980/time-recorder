BEGIN;

ALTER TABLE public.payroll_store_settings
  ADD COLUMN IF NOT EXISTS week_start_rule TEXT NOT NULL DEFAULT 'OTHER_REVIEW_REQUIRED'
    CHECK (week_start_rule IN ('CALENDAR_DEFAULT', 'EXPLICIT_WEEKDAY', 'OTHER_REVIEW_REQUIRED'));

-- Existing week_starts_on values came from an old Monday default and have no
-- provenance. Keep every existing row fail-closed until a manager explicitly
-- confirms the workplace rule in the payroll settings UI.
UPDATE public.payroll_store_settings
SET week_start_rule = 'OTHER_REVIEW_REQUIRED',
    updated_at = NOW()
WHERE week_start_rule <> 'OTHER_REVIEW_REQUIRED';

COMMIT;
