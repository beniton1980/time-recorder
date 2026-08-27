BEGIN;

-- Payroll settings are intentionally isolated from attendance facts.
-- Staff-facing request modes must never be able to read wage data.
CREATE TABLE public.payroll_store_settings (
  store_id UUID PRIMARY KEY REFERENCES public.stores(id) ON DELETE RESTRICT,
  work_time_system TEXT NOT NULL DEFAULT 'OTHER_REVIEW_REQUIRED'
    CHECK (work_time_system IN ('STANDARD_40H', 'SPECIAL_44H', 'OTHER_REVIEW_REQUIRED')),
  week_starts_on SMALLINT NOT NULL DEFAULT 1
    CHECK (week_starts_on BETWEEN 0 AND 6),
  overtime_premium_rate NUMERIC(6,5) NOT NULL DEFAULT 0.25
    CHECK (overtime_premium_rate >= 0),
  high_overtime_premium_rate NUMERIC(6,5) NOT NULL DEFAULT 0.50
    CHECK (high_overtime_premium_rate >= 0),
  statutory_holiday_premium_rate NUMERIC(6,5) NOT NULL DEFAULT 0.35
    CHECK (statutory_holiday_premium_rate >= 0),
  late_night_premium_rate NUMERIC(6,5) NOT NULL DEFAULT 0.25
    CHECK (late_night_premium_rate >= 0),
  rounding_mode TEXT NOT NULL DEFAULT 'ROUND'
    CHECK (rounding_mode IN ('ROUND', 'FLOOR', 'CEIL')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.payroll_compensation_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
  staff_id UUID NOT NULL,
  hourly_rate_yen INTEGER NOT NULL CHECK (hourly_rate_yen > 0),
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_by_line_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  FOREIGN KEY (staff_id, store_id)
    REFERENCES public.staff(id, store_id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_payroll_compensation_terms_staff_period
  ON public.payroll_compensation_terms(store_id, staff_id, effective_from, effective_to);

CREATE TABLE public.payroll_statutory_holidays (
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
  holiday_date DATE NOT NULL,
  created_by_line_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (store_id, holiday_date)
);

-- Fail closed on overlapping wage terms. A historical payroll result must resolve
-- to exactly one wage term for every worked date.
CREATE OR REPLACE FUNCTION public.prevent_overlapping_payroll_terms()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.payroll_compensation_terms existing
    WHERE existing.store_id = NEW.store_id
      AND existing.staff_id = NEW.staff_id
      AND existing.id <> NEW.id
      AND daterange(existing.effective_from, COALESCE(existing.effective_to + 1, 'infinity'::date), '[)')
          && daterange(NEW.effective_from, COALESCE(NEW.effective_to + 1, 'infinity'::date), '[)')
  ) THEN
    RAISE EXCEPTION 'overlapping payroll compensation terms'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payroll_compensation_terms_no_overlap
BEFORE INSERT OR UPDATE ON public.payroll_compensation_terms
FOR EACH ROW EXECUTE FUNCTION public.prevent_overlapping_payroll_terms();

ALTER TABLE public.payroll_store_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_compensation_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_statutory_holidays ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.payroll_store_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_compensation_terms FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_statutory_holidays FORCE ROW LEVEL SECURITY;

CREATE POLICY payroll_store_settings_manager_scope
  ON public.payroll_store_settings
  FOR ALL
  TO onogami_app
  USING (public.app_manager_store_allowed(store_id))
  WITH CHECK (public.app_manager_store_allowed(store_id));

CREATE POLICY payroll_compensation_terms_manager_scope
  ON public.payroll_compensation_terms
  FOR ALL
  TO onogami_app
  USING (public.app_manager_store_allowed(store_id))
  WITH CHECK (public.app_manager_store_allowed(store_id));

CREATE POLICY payroll_statutory_holidays_manager_scope
  ON public.payroll_statutory_holidays
  FOR ALL
  TO onogami_app
  USING (public.app_manager_store_allowed(store_id))
  WITH CHECK (public.app_manager_store_allowed(store_id));

REVOKE ALL ON public.payroll_store_settings FROM PUBLIC;
REVOKE ALL ON public.payroll_compensation_terms FROM PUBLIC;
REVOKE ALL ON public.payroll_statutory_holidays FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_overlapping_payroll_terms() FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_store_settings TO onogami_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_compensation_terms TO onogami_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_statutory_holidays TO onogami_app;

COMMIT;
