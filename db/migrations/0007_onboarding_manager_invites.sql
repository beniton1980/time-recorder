BEGIN;

ALTER TABLE onboarding_requests
  ADD COLUMN provisioned_store_id UUID UNIQUE REFERENCES stores(id);

CREATE TABLE onboarding_manager_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_request_id UUID NOT NULL UNIQUE
    REFERENCES onboarding_requests(id),
  store_id UUID NOT NULL REFERENCES stores(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by_line_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > created_at),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX idx_onboarding_manager_invites_store
  ON onboarding_manager_invites(store_id);

CREATE OR REPLACE FUNCTION provision_onboarding_request(
  p_request_id UUID,
  p_token_hash TEXT,
  p_operator_line_user_id TEXT
)
RETURNS TABLE (
  store_id UUID,
  store_name TEXT,
  invite_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  request_row onboarding_requests%ROWTYPE;
  new_store_id UUID;
  new_expires_at TIMESTAMPTZ := NOW() + INTERVAL '7 days';
BEGIN
  SELECT *
  INTO request_row
  FROM onboarding_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ONBOARDING_REQUEST_NOT_FOUND';
  END IF;

  IF request_row.status = 'PROVISIONED'
     OR request_row.provisioned_store_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ONBOARDING_REQUEST_ALREADY_PROVISIONED';
  END IF;

  IF request_row.status <> 'APPROVED' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ONBOARDING_REQUEST_NOT_APPROVED';
  END IF;

  INSERT INTO stores (
    name,
    timezone,
    business_day_start_minute,
    closing_rule,
    status
  )
  VALUES (
    request_row.store_name,
    request_row.timezone,
    request_row.business_day_start_minute,
    request_row.closing_rule,
    'suspended'
  )
  RETURNING id INTO new_store_id;

  INSERT INTO onboarding_manager_invites (
    onboarding_request_id,
    store_id,
    token_hash,
    expires_at,
    created_by_line_user_id
  )
  VALUES (
    request_row.id,
    new_store_id,
    p_token_hash,
    new_expires_at,
    p_operator_line_user_id
  );

  UPDATE onboarding_requests
  SET
    status = 'PROVISIONED',
    provisioned_at = NOW(),
    provisioned_store_id = new_store_id,
    updated_at = NOW()
  WHERE id = request_row.id;

  RETURN QUERY
  SELECT new_store_id, request_row.store_name, new_expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION claim_onboarding_manager_invite(
  p_token_hash TEXT,
  p_line_user_id TEXT
)
RETURNS TABLE (
  store_id UUID,
  store_name TEXT,
  staff_id UUID
)
LANGUAGE plpgsql
AS $$
DECLARE
  invite_row RECORD;
  new_staff_id UUID;
BEGIN
  SELECT
    invite.id,
    invite.store_id,
    request.manager_legal_name,
    store.name AS store_name
  INTO invite_row
  FROM onboarding_manager_invites invite
  JOIN onboarding_requests request
    ON request.id = invite.onboarding_request_id
  JOIN stores store ON store.id = invite.store_id
  WHERE invite.token_hash = p_token_hash
    AND invite.used_at IS NULL
    AND invite.revoked_at IS NULL
    AND invite.expires_at > NOW()
  FOR UPDATE OF invite;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MANAGER_INVITE_INVALID';
  END IF;

  INSERT INTO staff (
    store_id,
    line_user_id,
    legal_name,
    status,
    role
  )
  VALUES (
    invite_row.store_id,
    p_line_user_id,
    invite_row.manager_legal_name,
    'active',
    'MANAGER'
  )
  ON CONFLICT ON CONSTRAINT staff_store_id_line_user_id_key
  DO UPDATE SET
    legal_name = EXCLUDED.legal_name,
    status = 'active',
    role = 'MANAGER',
    updated_at = NOW()
  RETURNING id INTO new_staff_id;

  INSERT INTO staff_states (staff_id, state)
  VALUES (new_staff_id, 'OFF_DUTY')
  ON CONFLICT (staff_id) DO NOTHING;

  UPDATE onboarding_manager_invites
  SET used_at = NOW()
  WHERE id = invite_row.id;

  UPDATE stores
  SET status = 'active', updated_at = NOW()
  WHERE id = invite_row.store_id
    AND status = 'suspended';

  RETURN QUERY
  SELECT invite_row.store_id, invite_row.store_name, new_staff_id;
END;
$$;

COMMIT;
