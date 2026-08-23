BEGIN;

CREATE TABLE public.staff_manager_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id),
  staff_id UUID NOT NULL REFERENCES public.staff(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  granted_by_staff_id UUID NOT NULL REFERENCES public.staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (store_id, staff_id)
);

CREATE INDEX staff_manager_access_store_status_idx
  ON public.staff_manager_access(store_id, status);

ALTER TABLE public.staff_manager_access ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.staff_manager_access FROM onogami_app;

CREATE OR REPLACE FUNCTION public.app_manager_store_allowed(p_store_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS '
  SELECT COALESCE(
    public.app_request_setting(''mode'') = ''manager''
    AND (
      public.app_request_setting(''store_id'') IS NULL
      OR public.app_request_setting(''store_id'')::UUID = p_store_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.staff manager
      JOIN public.stores store ON store.id = manager.store_id
      LEFT JOIN public.staff_manager_access access
        ON access.staff_id = manager.id AND access.store_id = manager.store_id
      WHERE manager.store_id = p_store_id
        AND manager.line_user_id = public.app_request_setting(''line_user_id'')
        AND manager.status = ''active''
        AND store.status = ''active''
        AND (manager.role = ''MANAGER'' OR access.status = ''active'')
    ),
    FALSE
  )
';

CREATE POLICY staff_manager_access_manager_read ON public.staff_manager_access
  FOR SELECT TO onogami_app
  USING (public.app_manager_store_allowed(store_id));
GRANT SELECT ON public.staff_manager_access TO onogami_app;

CREATE OR REPLACE FUNCTION public.set_staff_manager_access(
  p_manager_line_user_id TEXT,
  p_store_id UUID,
  p_target_staff_id UUID,
  p_status TEXT
)
RETURNS TABLE (staff_id UUID, access_status TEXT)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS '
  WITH actor AS (
    SELECT id
    FROM public.staff
    WHERE store_id = p_store_id
      AND line_user_id = p_manager_line_user_id
      AND status = ''active''
      AND public.app_request_setting(''mode'') = ''manager''
      AND public.app_request_setting(''line_user_id'') = p_manager_line_user_id
      AND public.app_request_setting(''store_id'') = p_store_id::TEXT
      AND public.app_manager_store_allowed(p_store_id)
    LIMIT 1
  ), target AS (
    SELECT id
    FROM public.staff
    WHERE id = p_target_staff_id AND store_id = p_store_id
      AND role = ''STAFF'' AND line_user_id <> p_manager_line_user_id
      AND p_status IN (''active'', ''inactive'')
      AND (
        p_status = ''active''
        OR (
          (SELECT count(*) FROM public.staff owner
             WHERE owner.store_id = p_store_id AND owner.role = ''MANAGER'' AND owner.status = ''active'')
          +
          (SELECT count(*) FROM public.staff_manager_access active_access
             JOIN public.staff active_staff ON active_staff.id = active_access.staff_id
             WHERE active_access.store_id = p_store_id AND active_access.status = ''active'' AND active_staff.status = ''active'')
        ) > 1
      )
  )
  INSERT INTO public.staff_manager_access (store_id, staff_id, status, granted_by_staff_id, updated_at)
  SELECT p_store_id, target.id, p_status, actor.id, NOW() FROM actor CROSS JOIN target
  ON CONFLICT (store_id, staff_id) DO UPDATE
    SET status = EXCLUDED.status, granted_by_staff_id = EXCLUDED.granted_by_staff_id, updated_at = NOW()
  RETURNING staff_manager_access.staff_id, staff_manager_access.status
';

REVOKE ALL ON FUNCTION public.app_manager_store_allowed(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_staff_manager_access(TEXT, UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_manager_store_allowed(UUID) TO onogami_app;
GRANT EXECUTE ON FUNCTION public.set_staff_manager_access(TEXT, UUID, UUID, TEXT) TO onogami_app;
REVOKE EXECUTE ON FUNCTION public.create_store_manager_invite(TEXT, UUID, TEXT, TEXT) FROM onogami_app;
REVOKE EXECUTE ON FUNCTION public.claim_store_manager_invite(TEXT, TEXT) FROM onogami_app;
REVOKE EXECUTE ON FUNCTION public.set_store_manager_status(TEXT, UUID, UUID, TEXT) FROM onogami_app;

COMMIT;
