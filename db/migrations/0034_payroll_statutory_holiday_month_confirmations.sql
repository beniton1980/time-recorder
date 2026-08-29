BEGIN;

CREATE TABLE public.payroll_statutory_holiday_month_confirmations (
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
  holiday_month DATE NOT NULL,
  confirmed_by_line_user_id TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (store_id, holiday_month),
  CHECK (holiday_month = date_trunc('month', holiday_month)::date)
);

ALTER TABLE public.payroll_statutory_holiday_month_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_statutory_holiday_month_confirmations FORCE ROW LEVEL SECURITY;

CREATE POLICY payroll_statutory_holiday_month_confirmations_manager_scope
  ON public.payroll_statutory_holiday_month_confirmations
  FOR ALL
  TO onogami_app
  USING (public.app_manager_store_allowed(store_id))
  WITH CHECK (public.app_manager_store_allowed(store_id));

REVOKE ALL ON public.payroll_statutory_holiday_month_confirmations FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_statutory_holiday_month_confirmations TO onogami_app;

COMMIT;
