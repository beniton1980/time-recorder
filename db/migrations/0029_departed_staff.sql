BEGIN;

ALTER TABLE public.staff
  DROP CONSTRAINT staff_status_check;

ALTER TABLE public.staff
  ADD CONSTRAINT staff_status_check
  CHECK (status IN ('active', 'inactive', 'departed'));

CREATE OR REPLACE FUNCTION public.set_staff_membership_status(
  p_manager_line_user_id TEXT,
  p_store_id UUID,
  p_staff_id UUID,
  p_status TEXT
)
RETURNS TABLE (
  staff_id UUID,
  legal_name TEXT,
  status TEXT
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS '
  WITH target AS (
    SELECT st.id, st.legal_name
    FROM public.staff st
    JOIN public.staff_states ss ON ss.staff_id = st.id
    WHERE st.id = p_staff_id
      AND st.store_id = p_store_id
      AND st.role = ''STAFF''
      AND p_status IN (''active'', ''inactive'', ''departed'')
      AND public.app_request_setting(''mode'') = ''manager''
      AND public.app_request_setting(''line_user_id'') = p_manager_line_user_id
      AND public.app_request_setting(''store_id'') = p_store_id::TEXT
      AND public.app_manager_store_allowed(p_store_id)
      AND (p_status = ''active'' OR COALESCE(ss.state, ''OFF_DUTY'') = ''OFF_DUTY'')
    FOR UPDATE OF st, ss
  ), stopped_access AS (
    UPDATE public.staff_manager_access access
    SET status = ''inactive'', updated_at = NOW()
    FROM target
    WHERE p_status = ''departed''
      AND access.staff_id = target.id
      AND access.store_id = p_store_id
    RETURNING access.staff_id
  ), updated AS (
    UPDATE public.staff st
    SET status = p_status, updated_at = NOW()
    FROM target
    WHERE st.id = target.id
    RETURNING st.id, target.legal_name, st.status
  )
  SELECT updated.id, updated.legal_name, updated.status
  FROM updated
';

REVOKE ALL ON FUNCTION public.set_staff_membership_status(TEXT, UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_staff_membership_status(TEXT, UUID, UUID, TEXT) TO onogami_app;

COMMIT;
