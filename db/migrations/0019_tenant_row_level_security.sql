BEGIN;

-- Every runtime query is paired with its request context in the same
-- non-interactive transaction. These helpers keep policy expressions small and
-- fail closed when a setting is missing.
CREATE OR REPLACE FUNCTION public.app_request_setting(p_name TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.request_' || p_name, TRUE), '')
$$;

CREATE OR REPLACE FUNCTION public.app_token_store_allowed(p_store_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.store_entry_tokens token
    JOIN public.stores store ON store.id = token.store_id
    WHERE token.store_id = p_store_id
      AND token.token_hash = public.app_request_setting('store_token_hash')
      AND token.active = TRUE
      AND token.revoked_at IS NULL
      AND (token.expires_at IS NULL OR token.expires_at > NOW())
      AND store.status = 'active'
  )
$$;

CREATE OR REPLACE FUNCTION public.app_actor_owns_staff(p_staff_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.staff st
    WHERE st.id = p_staff_id
      AND st.line_user_id = public.app_request_setting('line_user_id')
  )
$$;

CREATE OR REPLACE FUNCTION public.app_actor_store_allowed(p_store_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.staff st
    WHERE st.store_id = p_store_id
      AND st.line_user_id = public.app_request_setting('line_user_id')
  )
$$;

CREATE OR REPLACE FUNCTION public.app_manager_store_allowed(p_store_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.app_request_setting('mode') = 'manager'
    AND (
      public.app_request_setting('store_id') IS NULL
      OR public.app_request_setting('store_id')::UUID = p_store_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.staff manager
      JOIN public.stores store ON store.id = manager.store_id
      WHERE manager.store_id = p_store_id
        AND manager.line_user_id = public.app_request_setting('line_user_id')
        AND manager.role = 'MANAGER'
        AND manager.status = 'active'
        AND store.status = 'active'
    )
$$;

CREATE OR REPLACE FUNCTION public.app_manager_staff_allowed(p_staff_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.staff target
    WHERE target.id = p_staff_id
      AND public.app_manager_store_allowed(target.store_id)
  )
$$;

CREATE OR REPLACE FUNCTION public.app_invite_store_allowed(p_store_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.app_request_setting('mode') = 'invite_claim'
    AND EXISTS (
      SELECT 1
      FROM public.onboarding_manager_invites invite
      WHERE invite.store_id = p_store_id
        AND invite.token_hash = public.app_request_setting('invite_token_hash')
    )
$$;

REVOKE ALL ON FUNCTION public.app_request_setting(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_token_store_allowed(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_actor_owns_staff(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_actor_store_allowed(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_manager_store_allowed(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_manager_staff_allowed(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_invite_store_allowed(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.app_request_setting(TEXT) TO onogami_app;
GRANT EXECUTE ON FUNCTION public.app_token_store_allowed(UUID) TO onogami_app;
GRANT EXECUTE ON FUNCTION public.app_actor_owns_staff(UUID) TO onogami_app;
GRANT EXECUTE ON FUNCTION public.app_actor_store_allowed(UUID) TO onogami_app;
GRANT EXECUTE ON FUNCTION public.app_manager_store_allowed(UUID) TO onogami_app;
GRANT EXECUTE ON FUNCTION public.app_manager_staff_allowed(UUID) TO onogami_app;
GRANT EXECUTE ON FUNCTION public.app_invite_store_allowed(UUID) TO onogami_app;

ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_entry_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.punch_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.correction_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_manager_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monthly_attendance_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY stores_runtime_scope ON public.stores TO onogami_app
  USING (
    public.app_request_setting('mode') IN ('operator', 'cron')
    OR public.app_manager_store_allowed(id)
    OR (
      public.app_request_setting('mode') IN ('staff', 'registration')
      AND (
        public.app_token_store_allowed(id)
        OR public.app_actor_store_allowed(id)
      )
    )
    OR public.app_invite_store_allowed(id)
  )
  WITH CHECK (
    public.app_request_setting('mode') = 'operator'
    OR public.app_invite_store_allowed(id)
  );

CREATE POLICY store_entry_tokens_runtime_scope ON public.store_entry_tokens TO onogami_app
  USING (
    public.app_request_setting('mode') = 'operator'
    OR public.app_manager_store_allowed(store_id)
    OR (
      public.app_request_setting('mode') IN ('staff', 'registration')
      AND token_hash = public.app_request_setting('store_token_hash')
      AND public.app_token_store_allowed(store_id)
    )
    OR public.app_invite_store_allowed(store_id)
  )
  WITH CHECK (
    public.app_request_setting('mode') = 'operator'
    OR public.app_manager_store_allowed(store_id)
    OR public.app_invite_store_allowed(store_id)
  );

CREATE POLICY staff_runtime_scope ON public.staff TO onogami_app
  USING (
    public.app_request_setting('mode') IN ('operator', 'cron')
    OR public.app_manager_store_allowed(store_id)
    OR (
      public.app_request_setting('mode') IN ('staff', 'registration')
      AND line_user_id = public.app_request_setting('line_user_id')
    )
    OR (
      public.app_request_setting('mode') = 'invite_claim'
      AND line_user_id = public.app_request_setting('line_user_id')
      AND public.app_invite_store_allowed(store_id)
    )
  )
  WITH CHECK (
    public.app_request_setting('mode') = 'operator'
    OR (
      public.app_request_setting('mode') = 'manager'
      AND role = 'STAFF'
      AND public.app_manager_store_allowed(store_id)
    )
    OR (
      public.app_request_setting('mode') = 'registration'
      AND role = 'STAFF'
      AND line_user_id = public.app_request_setting('line_user_id')
      AND public.app_token_store_allowed(store_id)
    )
    OR (
      public.app_request_setting('mode') = 'invite_claim'
      AND role = 'MANAGER'
      AND line_user_id = public.app_request_setting('line_user_id')
      AND public.app_invite_store_allowed(store_id)
    )
  );

CREATE POLICY staff_states_runtime_scope ON public.staff_states TO onogami_app
  USING (
    public.app_request_setting('mode') IN ('operator', 'cron')
    OR public.app_manager_staff_allowed(staff_id)
    OR (
      public.app_request_setting('mode') IN ('staff', 'registration')
      AND public.app_actor_owns_staff(staff_id)
    )
    OR (
      public.app_request_setting('mode') = 'invite_claim'
      AND public.app_actor_owns_staff(staff_id)
    )
  )
  WITH CHECK (
    public.app_request_setting('mode') = 'operator'
    OR public.app_manager_staff_allowed(staff_id)
    OR (
      public.app_request_setting('mode') IN ('staff', 'registration', 'invite_claim')
      AND public.app_actor_owns_staff(staff_id)
    )
  );

CREATE POLICY punch_events_runtime_scope ON public.punch_events TO onogami_app
  USING (
    public.app_request_setting('mode') IN ('operator', 'cron')
    OR public.app_manager_store_allowed(store_id)
    OR (
      public.app_request_setting('mode') = 'staff'
      AND public.app_actor_owns_staff(staff_id)
    )
  )
  WITH CHECK (
    public.app_request_setting('mode') = 'operator'
    OR (
      public.app_request_setting('mode') = 'staff'
      AND public.app_actor_owns_staff(staff_id)
      AND public.app_token_store_allowed(store_id)
    )
    OR (
      public.app_request_setting('mode') = 'manager'
      AND public.app_manager_store_allowed(store_id)
      AND public.app_manager_staff_allowed(staff_id)
    )
  );

CREATE POLICY correction_requests_runtime_scope ON public.correction_requests TO onogami_app
  USING (
    public.app_request_setting('mode') IN ('operator', 'cron')
    OR public.app_manager_store_allowed(store_id)
    OR (
      public.app_request_setting('mode') = 'staff'
      AND public.app_actor_owns_staff(staff_id)
    )
  )
  WITH CHECK (
    public.app_request_setting('mode') = 'operator'
    OR (
      public.app_request_setting('mode') = 'staff'
      AND public.app_actor_owns_staff(staff_id)
      AND public.app_token_store_allowed(store_id)
    )
    OR (
      public.app_request_setting('mode') = 'manager'
      AND public.app_manager_store_allowed(store_id)
      AND public.app_manager_staff_allowed(staff_id)
    )
  );

CREATE POLICY onboarding_requests_runtime_scope ON public.onboarding_requests TO onogami_app
  USING (
    public.app_request_setting('mode') IN ('operator', 'cron')
    OR (
      public.app_request_setting('mode') = 'onboarding_public'
      AND client_request_id::TEXT = public.app_request_setting('client_request_id')
    )
    OR (
      public.app_request_setting('mode') = 'invite_claim'
      AND public.app_invite_store_allowed(provisioned_store_id)
    )
  )
  WITH CHECK (
    public.app_request_setting('mode') = 'operator'
    OR (
      public.app_request_setting('mode') = 'onboarding_public'
      AND client_request_id::TEXT = public.app_request_setting('client_request_id')
    )
  );

CREATE POLICY onboarding_manager_invites_runtime_scope
  ON public.onboarding_manager_invites TO onogami_app
  USING (
    public.app_request_setting('mode') = 'operator'
    OR (
      public.app_request_setting('mode') = 'invite_claim'
      AND token_hash = public.app_request_setting('invite_token_hash')
    )
  )
  WITH CHECK (
    public.app_request_setting('mode') = 'operator'
    OR (
      public.app_request_setting('mode') = 'invite_claim'
      AND token_hash = public.app_request_setting('invite_token_hash')
    )
  );

CREATE POLICY monthly_attendance_deliveries_runtime_scope
  ON public.monthly_attendance_deliveries TO onogami_app
  USING (
    public.app_request_setting('mode') IN ('operator', 'cron')
    OR public.app_manager_store_allowed(store_id)
  )
  WITH CHECK (
    public.app_request_setting('mode') IN ('operator', 'cron')
    OR public.app_manager_store_allowed(store_id)
  );

CREATE POLICY api_rate_limits_runtime_scope ON public.api_rate_limits TO onogami_app
  USING (public.app_request_setting('mode') = 'rate_limit')
  WITH CHECK (public.app_request_setting('mode') = 'rate_limit');

-- Views owned by the schema owner otherwise bypass policies on their source
-- tables. PostgreSQL 15+ security_invoker makes the caller's RLS apply.
ALTER VIEW public.effective_punch_events SET (security_invoker = TRUE);

-- A staff identifier must never be paired with a different store identifier.
-- The composite references also protect correction targets and staff state.
ALTER TABLE public.staff
  ADD CONSTRAINT uq_staff_id_store UNIQUE (id, store_id);

ALTER TABLE public.punch_events
  ADD CONSTRAINT uq_punch_events_id_staff UNIQUE (id, staff_id);

ALTER TABLE public.punch_events
  ADD CONSTRAINT uq_punch_events_id_staff_store UNIQUE (id, staff_id, store_id);

ALTER TABLE public.correction_requests
  ADD CONSTRAINT uq_correction_requests_id_staff_store UNIQUE (id, staff_id, store_id);

ALTER TABLE public.punch_events
  ADD CONSTRAINT fk_punch_events_staff_store
  FOREIGN KEY (staff_id, store_id)
  REFERENCES public.staff(id, store_id)
  NOT VALID;

ALTER TABLE public.correction_requests
  ADD CONSTRAINT fk_correction_requests_staff_store
  FOREIGN KEY (staff_id, store_id)
  REFERENCES public.staff(id, store_id)
  NOT VALID;

ALTER TABLE public.staff_states
  ADD CONSTRAINT fk_staff_states_last_event_staff
  FOREIGN KEY (last_event_id, staff_id)
  REFERENCES public.punch_events(id, staff_id)
  NOT VALID;

ALTER TABLE public.correction_requests
  ADD CONSTRAINT fk_correction_target_event_staff_store
  FOREIGN KEY (target_event_id, staff_id, store_id)
  REFERENCES public.punch_events(id, staff_id, store_id)
  NOT VALID;

ALTER TABLE public.correction_requests
  ADD CONSTRAINT fk_correction_target_correction_staff_store
  FOREIGN KEY (target_correction_id, staff_id, store_id)
  REFERENCES public.correction_requests(id, staff_id, store_id)
  NOT VALID;

ALTER TABLE public.punch_events VALIDATE CONSTRAINT fk_punch_events_staff_store;
ALTER TABLE public.correction_requests VALIDATE CONSTRAINT fk_correction_requests_staff_store;
ALTER TABLE public.staff_states VALIDATE CONSTRAINT fk_staff_states_last_event_staff;
ALTER TABLE public.correction_requests VALIDATE CONSTRAINT fk_correction_target_event_staff_store;
ALTER TABLE public.correction_requests VALIDATE CONSTRAINT fk_correction_target_correction_staff_store;

COMMIT;
