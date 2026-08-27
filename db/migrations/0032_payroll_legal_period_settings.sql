BEGIN;

ALTER TABLE public.payroll_store_settings
  ADD COLUMN overtime_month_rule TEXT NOT NULL DEFAULT 'OTHER_REVIEW_REQUIRED'
    CHECK (overtime_month_rule IN ('PAY_PERIOD', 'CALENDAR_MONTH', 'OTHER_REVIEW_REQUIRED')),
  ADD COLUMN statutory_holiday_rule TEXT NOT NULL DEFAULT 'OTHER_REVIEW_REQUIRED'
    CHECK (statutory_holiday_rule IN ('FIXED_WEEKDAY', 'MANUAL_DATES', 'OTHER_REVIEW_REQUIRED')),
  ADD COLUMN statutory_holiday_weekday SMALLINT
    CHECK (statutory_holiday_weekday BETWEEN 0 AND 6),
  ADD CONSTRAINT payroll_statutory_holiday_rule_consistency CHECK (
    (statutory_holiday_rule = 'FIXED_WEEKDAY' AND statutory_holiday_weekday IS NOT NULL)
    OR (statutory_holiday_rule <> 'FIXED_WEEKDAY' AND statutory_holiday_weekday IS NULL)
  );

COMMIT;
