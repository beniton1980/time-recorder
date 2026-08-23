CREATE OR REPLACE FUNCTION public.set_manager_store_location(
  p_manager_line_user_id TEXT,
  p_store_id UUID,
  p_latitude DOUBLE PRECISION,
  p_longitude DOUBLE PRECISION
)
RETURNS TABLE (
  store_id UUID,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  updated_at TIMESTAMPTZ
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS '
  UPDATE public.stores store
  SET latitude = p_latitude,
      longitude = p_longitude,
      updated_at = NOW()
  WHERE store.id = p_store_id
    AND store.status = ''active''
    AND p_manager_line_user_id = public.app_request_setting(''line_user_id'')
    AND public.app_request_setting(''mode'') = ''manager''
    AND public.app_request_setting(''store_id'') = p_store_id::TEXT
    AND p_latitude BETWEEN -90 AND 90
    AND p_longitude BETWEEN -180 AND 180
    AND public.app_manager_store_allowed(p_store_id)
  RETURNING store.id, store.latitude, store.longitude, store.updated_at
';

REVOKE ALL ON FUNCTION public.set_manager_store_location(TEXT, UUID, DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_manager_store_location(TEXT, UUID, DOUBLE PRECISION, DOUBLE PRECISION) TO onogami_app;
