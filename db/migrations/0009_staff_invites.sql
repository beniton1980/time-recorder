BEGIN;

CREATE TABLE staff_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id),
  legal_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  client_request_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by_staff_id UUID NOT NULL REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (store_id, client_request_id),
  CHECK (char_length(legal_name) BETWEEN 1 AND 100),
  CHECK (expires_at > created_at),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX idx_staff_invites_store_created
  ON staff_invites(store_id, created_at DESC);

CREATE OR REPLACE FUNCTION issue_staff_invite(
  p_store_id UUID,
  p_legal_name TEXT,
  p_token_hash TEXT,
  p_client_request_id UUID,
  p_created_by_staff_id UUID
)
RETURNS TABLE (invite_id UUID, invite_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
  new_id UUID;
  new_expires_at TIMESTAMPTZ := NOW() + INTERVAL '7 days';
BEGIN
  PERFORM 1
  FROM staff creator
  JOIN stores s ON s.id = creator.store_id
  WHERE creator.id = p_created_by_staff_id
    AND creator.store_id = p_store_id
    AND creator.role = 'MANAGER'
    AND creator.status = 'active'
    AND s.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MANAGER_ACCESS_REQUIRED';
  END IF;

  IF EXISTS (
    SELECT 1 FROM staff_invites
    WHERE store_id = p_store_id AND client_request_id = p_client_request_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STAFF_INVITE_ALREADY_ISSUED';
  END IF;

  INSERT INTO staff_invites (
    store_id, legal_name, token_hash, client_request_id,
    expires_at, created_by_staff_id
  ) VALUES (
    p_store_id, trim(p_legal_name), p_token_hash, p_client_request_id,
    new_expires_at, p_created_by_staff_id
  ) RETURNING id INTO new_id;

  RETURN QUERY SELECT new_id, new_expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION revoke_staff_invite(
  p_invite_id UUID,
  p_store_id UUID,
  p_manager_staff_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  changed_count INTEGER;
BEGIN
  PERFORM 1 FROM staff
  WHERE id = p_manager_staff_id
    AND store_id = p_store_id
    AND role = 'MANAGER'
    AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MANAGER_ACCESS_REQUIRED';
  END IF;

  UPDATE staff_invites
  SET revoked_at = NOW()
  WHERE id = p_invite_id
    AND store_id = p_store_id
    AND used_at IS NULL
    AND revoked_at IS NULL;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count > 0;
END;
$$;

CREATE OR REPLACE FUNCTION claim_staff_invite(
  p_token_hash TEXT,
  p_line_user_id TEXT
)
RETURNS TABLE (staff_id UUID, store_id UUID, store_name TEXT, legal_name TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  invite staff_invites%ROWTYPE;
  new_staff_id UUID;
  claimed_store_name TEXT;
BEGIN
  SELECT * INTO invite
  FROM staff_invites
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND OR invite.used_at IS NOT NULL OR invite.revoked_at IS NOT NULL
     OR invite.expires_at <= NOW() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STAFF_INVITE_INVALID';
  END IF;

  SELECT name INTO claimed_store_name
  FROM stores WHERE id = invite.store_id AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STORE_NOT_ACTIVE';
  END IF;

  IF EXISTS (
    SELECT 1 FROM staff
    WHERE store_id = invite.store_id AND line_user_id = p_line_user_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STAFF_ALREADY_REGISTERED';
  END IF;

  INSERT INTO staff (store_id, line_user_id, legal_name, status, role)
  VALUES (invite.store_id, p_line_user_id, invite.legal_name, 'active', 'STAFF')
  RETURNING id INTO new_staff_id;

  INSERT INTO staff_states (staff_id, state)
  VALUES (new_staff_id, 'OFF_DUTY');

  UPDATE staff_invites SET used_at = NOW() WHERE id = invite.id;

  RETURN QUERY
  SELECT new_staff_id, invite.store_id, claimed_store_name, invite.legal_name;
END;
$$;

COMMIT;
