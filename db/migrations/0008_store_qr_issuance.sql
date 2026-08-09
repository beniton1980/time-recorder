BEGIN;

CREATE OR REPLACE FUNCTION rotate_store_entry_token(
  p_store_id UUID,
  p_token_hash TEXT
)
RETURNS TABLE (
  entry_token_id UUID,
  revoked_count INTEGER
)
LANGUAGE plpgsql
AS $$
DECLARE
  revoked_total INTEGER;
  created_token_id UUID;
BEGIN
  PERFORM 1 FROM stores WHERE id = p_store_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STORE_NOT_ACTIVE';
  END IF;

  UPDATE store_entry_tokens
  SET active = FALSE, revoked_at = COALESCE(revoked_at, NOW())
  WHERE store_id = p_store_id
    AND active = TRUE
    AND revoked_at IS NULL;
  GET DIAGNOSTICS revoked_total = ROW_COUNT;

  INSERT INTO store_entry_tokens (store_id, token_hash, active)
  VALUES (p_store_id, p_token_hash, TRUE)
  RETURNING id INTO created_token_id;

  RETURN QUERY SELECT created_token_id, revoked_total;
END;
$$;

CREATE OR REPLACE FUNCTION revoke_store_entry_tokens(p_store_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  revoked_total INTEGER;
BEGIN
  PERFORM 1 FROM stores WHERE id = p_store_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STORE_NOT_FOUND';
  END IF;

  UPDATE store_entry_tokens
  SET active = FALSE, revoked_at = COALESCE(revoked_at, NOW())
  WHERE store_id = p_store_id
    AND active = TRUE
    AND revoked_at IS NULL;
  GET DIAGNOSTICS revoked_total = ROW_COUNT;

  RETURN revoked_total;
END;
$$;

COMMIT;
