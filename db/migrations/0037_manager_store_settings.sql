CREATE OR REPLACE FUNCTION public.set_manager_store_settings(
  p_manager_line_user_id TEXT,
  p_store_id UUID,
  p_closing_rule TEXT,
  p_business_day_start_minute INTEGER
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  closing_rule TEXT,
  business_day_start_minute INTEGER,
  monthly_report_email TEXT
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS '
  UPDATE public.stores store
  SET closing_rule = p_closing_rule,
      business_day_start_minute = p_business_day_start_minute,
      updated_at = NOW()
  WHERE store.id = p_store_id
    AND store.status = ''active''
    AND p_manager_line_user_id = public.app_request_setting(''line_user_id'')
    AND public.app_request_setting(''mode'') = ''manager''
    AND public.app_request_setting(''store_id'') = p_store_id::TEXT
    AND p_closing_rule IN (''month_end'', ''day_15'', ''day_25'')
    AND p_business_day_start_minute >= 0
    AND p_business_day_start_minute < 1440
    AND public.app_manager_store_allowed(p_store_id)
  RETURNING store.id, store.name, store.closing_rule,
    store.business_day_start_minute, store.monthly_report_email
';

REVOKE ALL ON FUNCTION public.set_manager_store_settings(TEXT, UUID, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_manager_store_settings(TEXT, UUID, TEXT, INTEGER) TO onogami_app;
