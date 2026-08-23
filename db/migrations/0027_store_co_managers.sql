BEGIN;

CREATE TABLE public.store_manager_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id),
  legal_name TEXT NOT NULL CHECK (char_length(btrim(legal_name)) BETWEEN 1 AND 100),
  token_hash TEXT NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by_staff_id UUID NOT NULL REFERENCES public.staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > created_at)
);

CREATE INDEX store_manager_invites_store_idx
  ON public.store_manager_invites(store_id, created_at DESC);

ALTER TABLE public.store_manager_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY store_manager_invites_manager_read ON public.store_manager_invites
  FOR SELECT TO onogami_app
  USING (public.app_manager_store_allowed(store_id));

GRANT SELECT ON public.store_manager_invites TO onogami_app;

CREATE OR REPLACE FUNCTION public.create_store_manager_invite(
  p_manager_line_user_id TEXT,
  p_store_id UUID,
  p_legal_name TEXT,
  p_token_hash TEXT
)
RETURNS TABLE (invite_id UUID, expires_at TIMESTAMPTZ)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS '
  WITH actor AS (
    SELECT id FROM public.staff
    WHERE store_id = p_store_id AND line_user_id = p_manager_line_user_id
      AND role = ''MANAGER'' AND status = ''active''
      AND public.app_request_setting(''mode'') = ''manager''
      AND public.app_request_setting(''line_user_id'') = p_manager_line_user_id
      AND public.app_request_setting(''store_id'') = p_store_id::TEXT
      AND public.app_manager_store_allowed(p_store_id)
      AND char_length(btrim(p_legal_name)) BETWEEN 1 AND 100
      AND p_token_hash ~ ''^[0-9a-f]{64}$''
    LIMIT 1
  ), revoked AS (
    UPDATE public.store_manager_invites SET revoked_at = NOW()
    WHERE store_id = p_store_id AND legal_name = btrim(p_legal_name)
      AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
      AND EXISTS (SELECT 1 FROM actor)
  )
  INSERT INTO public.store_manager_invites (store_id, legal_name, token_hash, expires_at, created_by_staff_id)
  SELECT p_store_id, btrim(p_legal_name), p_token_hash, NOW() + INTERVAL ''7 days'', actor.id FROM actor
  RETURNING id, store_manager_invites.expires_at
';

CREATE OR REPLACE FUNCTION public.claim_store_manager_invite(
  p_line_user_id TEXT,
  p_token_hash TEXT
)
RETURNS TABLE (staff_id UUID, store_id UUID, store_name TEXT, legal_name TEXT)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS '
  WITH claimed AS (
    UPDATE public.store_manager_invites invite SET used_at = NOW()
    FROM public.stores store
    WHERE invite.token_hash = p_token_hash AND invite.store_id = store.id
      AND invite.used_at IS NULL AND invite.revoked_at IS NULL AND invite.expires_at > NOW()
      AND store.status = ''active''
      AND public.app_request_setting(''mode'') = ''invite_claim''
      AND public.app_request_setting(''line_user_id'') = p_line_user_id
      AND public.app_request_setting(''invite_token_hash'') = p_token_hash
    RETURNING invite.store_id, invite.legal_name
  ), membership AS (
    INSERT INTO public.staff (store_id, line_user_id, legal_name, role, status)
    SELECT store_id, p_line_user_id, legal_name, ''MANAGER'', ''active'' FROM claimed
    ON CONFLICT (store_id, line_user_id) DO UPDATE
      SET legal_name = EXCLUDED.legal_name, role = ''MANAGER'', status = ''active'', updated_at = NOW()
    RETURNING id, staff.store_id, staff.legal_name
  ), state_created AS (
    INSERT INTO public.staff_states (staff_id, state)
    SELECT id, ''OFF_DUTY'' FROM membership ON CONFLICT (staff_id) DO NOTHING
  )
  SELECT membership.id, store.id, store.name, membership.legal_name
  FROM membership JOIN public.stores store ON store.id = membership.store_id
';

CREATE OR REPLACE FUNCTION public.set_store_manager_status(
  p_manager_line_user_id TEXT,
  p_store_id UUID,
  p_target_staff_id UUID,
  p_status TEXT
)
RETURNS TABLE (staff_id UUID, membership_status TEXT)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS '
  UPDATE public.staff target SET status = p_status, updated_at = NOW()
  WHERE target.id = p_target_staff_id AND target.store_id = p_store_id AND target.role = ''MANAGER''
    AND target.line_user_id <> p_manager_line_user_id
    AND p_status IN (''active'', ''inactive'')
    AND public.app_request_setting(''mode'') = ''manager''
    AND public.app_request_setting(''line_user_id'') = p_manager_line_user_id
    AND public.app_request_setting(''store_id'') = p_store_id::TEXT
    AND public.app_manager_store_allowed(p_store_id)
    AND (p_status = ''active'' OR (SELECT count(*) FROM public.staff active_manager WHERE active_manager.store_id = p_store_id AND active_manager.role = ''MANAGER'' AND active_manager.status = ''active'') > 1)
  RETURNING target.id, target.status
';

REVOKE ALL ON FUNCTION public.create_store_manager_invite(TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_store_manager_invite(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_store_manager_status(TEXT, UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_store_manager_invite(TEXT, UUID, TEXT, TEXT) TO onogami_app;
GRANT EXECUTE ON FUNCTION public.claim_store_manager_invite(TEXT, TEXT) TO onogami_app;
GRANT EXECUTE ON FUNCTION public.set_store_manager_status(TEXT, UUID, UUID, TEXT) TO onogami_app;

COMMIT;
