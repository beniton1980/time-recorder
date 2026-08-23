BEGIN;

CREATE OR REPLACE FUNCTION public.app_manager_store_allowed(p_store_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(
    public.app_request_setting('mode') = 'manager'
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
    ),
    FALSE
  )
$$;

REVOKE ALL ON FUNCTION public.app_manager_store_allowed(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_manager_store_allowed(UUID) TO onogami_app;

COMMIT;
