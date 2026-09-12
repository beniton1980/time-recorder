-- Changing the business-day boundary needs a separate effective-date design.
CREATE OR REPLACE FUNCTION public.set_manager_store_settings(
  p_manager_line_user_id TEXT,
  p_store_id UUID,
  p_closing_rule TEXT,
  p_expected_closing_rule TEXT
)
RETURNS TABLE (id UUID, name TEXT, closing_rule TEXT)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS '
  UPDATE public.stores store
  SET closing_rule = p_closing_rule, updated_at = NOW()
  WHERE store.id = p_store_id
    AND store.status = ''active''
    AND p_manager_line_user_id = public.app_request_setting(''line_user_id'')
    AND public.app_request_setting(''mode'') = ''manager''
    AND public.app_request_setting(''store_id'') = p_store_id::TEXT
    AND p_closing_rule IN (''month_end'', ''day_15'', ''day_25'')
    AND store.closing_rule = p_expected_closing_rule
    AND public.app_manager_store_allowed(p_store_id)
  RETURNING store.id, store.name, store.closing_rule
';
REVOKE ALL ON FUNCTION public.set_manager_store_settings(TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_manager_store_settings(TEXT, UUID, TEXT, TEXT) TO onogami_app;
