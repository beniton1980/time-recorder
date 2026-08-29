BEGIN;

CREATE TABLE public.payroll_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  gross_pay_yen INTEGER NOT NULL CHECK (gross_pay_yen >= 0),
  calculation_spec_version TEXT NOT NULL,
  settings_snapshot JSONB NOT NULL,
  saved_by_line_user_id TEXT NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (period_end >= period_start),
  UNIQUE (id, store_id)
);

CREATE INDEX idx_payroll_runs_store_period
  ON public.payroll_runs(store_id, period_start DESC, period_end DESC, saved_at DESC);

CREATE TABLE public.payroll_run_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id UUID NOT NULL,
  store_id UUID NOT NULL,
  staff_id UUID NOT NULL,
  legal_name_snapshot TEXT NOT NULL,
  hourly_rates_used JSONB NOT NULL,
  minutes_snapshot JSONB NOT NULL,
  components_snapshot JSONB NOT NULL,
  gross_pay_yen INTEGER NOT NULL CHECK (gross_pay_yen >= 0),
  calculation_spec_version TEXT NOT NULL,
  source_attendance_spec_versions JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (payroll_run_id, store_id)
    REFERENCES public.payroll_runs(id, store_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (staff_id, store_id)
    REFERENCES public.staff(id, store_id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_payroll_run_items_run
  ON public.payroll_run_items(store_id, payroll_run_id, staff_id);

ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_run_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_run_items FORCE ROW LEVEL SECURITY;

CREATE POLICY payroll_runs_manager_select
  ON public.payroll_runs
  FOR SELECT
  TO onogami_app
  USING (public.app_manager_store_allowed(store_id));

CREATE POLICY payroll_runs_manager_insert
  ON public.payroll_runs
  FOR INSERT
  TO onogami_app
  WITH CHECK (public.app_manager_store_allowed(store_id));

CREATE POLICY payroll_run_items_manager_select
  ON public.payroll_run_items
  FOR SELECT
  TO onogami_app
  USING (public.app_manager_store_allowed(store_id));

CREATE POLICY payroll_run_items_manager_insert
  ON public.payroll_run_items
  FOR INSERT
  TO onogami_app
  WITH CHECK (public.app_manager_store_allowed(store_id));

REVOKE ALL ON public.payroll_runs FROM PUBLIC;
REVOKE ALL ON public.payroll_run_items FROM PUBLIC;
REVOKE ALL ON public.payroll_runs FROM onogami_app;
REVOKE ALL ON public.payroll_run_items FROM onogami_app;
GRANT SELECT, INSERT ON public.payroll_runs TO onogami_app;
GRANT SELECT, INSERT ON public.payroll_run_items TO onogami_app;

COMMIT;
