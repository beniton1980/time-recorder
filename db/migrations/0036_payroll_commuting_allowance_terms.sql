BEGIN;

CREATE TABLE public.payroll_commuting_allowance_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
  staff_id UUID NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('MONTHLY_PASS', 'PER_WORKDAY_GAS')),
  amount_yen INTEGER NOT NULL CHECK (amount_yen >= 0),
  effective_from DATE NOT NULL,
  effective_to DATE,
  basis_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_line_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  FOREIGN KEY (staff_id, store_id) REFERENCES public.staff(id, store_id) ON DELETE RESTRICT,
  EXCLUDE USING gist (
    store_id WITH =,
    staff_id WITH =,
    daterange(effective_from, COALESCE(effective_to + 1, 'infinity'::date), '[)') WITH &&
  )
);

CREATE INDEX idx_payroll_commuting_allowance_terms_staff_period
  ON public.payroll_commuting_allowance_terms(store_id, staff_id, effective_from, effective_to);

ALTER TABLE public.payroll_run_items
  ADD COLUMN commuting_allowance_snapshot JSONB;

ALTER TABLE public.payroll_commuting_allowance_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_commuting_allowance_terms FORCE ROW LEVEL SECURITY;

CREATE POLICY payroll_commuting_allowance_terms_manager_scope
  ON public.payroll_commuting_allowance_terms FOR ALL TO onogami_app
  USING (public.app_manager_store_allowed(store_id))
  WITH CHECK (public.app_manager_store_allowed(store_id));

REVOKE ALL ON public.payroll_commuting_allowance_terms FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.payroll_commuting_allowance_terms TO onogami_app;

COMMIT;
