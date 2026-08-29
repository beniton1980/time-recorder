BEGIN;

CREATE TABLE public.staff_other_employment_confirmations (
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
  staff_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('NONE', 'HAS_OTHER_EMPLOYER', 'UNKNOWN')),
  confirmed_by_line_user_id TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (store_id, staff_id),
  FOREIGN KEY (staff_id, store_id)
    REFERENCES public.staff(id, store_id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_staff_other_employment_reconfirmation
  ON public.staff_other_employment_confirmations(store_id, confirmed_at);

ALTER TABLE public.staff_other_employment_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_other_employment_confirmations FORCE ROW LEVEL SECURITY;

CREATE POLICY staff_other_employment_confirmations_manager_select
  ON public.staff_other_employment_confirmations
  FOR SELECT
  TO onogami_app
  USING (public.app_manager_store_allowed(store_id));

CREATE POLICY staff_other_employment_confirmations_manager_insert
  ON public.staff_other_employment_confirmations
  FOR INSERT
  TO onogami_app
  WITH CHECK (public.app_manager_store_allowed(store_id));

CREATE POLICY staff_other_employment_confirmations_manager_update
  ON public.staff_other_employment_confirmations
  FOR UPDATE
  TO onogami_app
  USING (public.app_manager_store_allowed(store_id))
  WITH CHECK (public.app_manager_store_allowed(store_id));

REVOKE ALL ON public.staff_other_employment_confirmations FROM PUBLIC;
REVOKE ALL ON public.staff_other_employment_confirmations FROM onogami_app;
GRANT SELECT, INSERT, UPDATE ON public.staff_other_employment_confirmations TO onogami_app;

COMMIT;
