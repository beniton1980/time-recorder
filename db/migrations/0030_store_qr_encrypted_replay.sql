BEGIN;

ALTER TABLE public.store_entry_tokens
  ADD COLUMN IF NOT EXISTS token_ciphertext TEXT;

COMMENT ON COLUMN public.store_entry_tokens.token_ciphertext IS
  'AES-256-GCM encrypted store entry token. Plaintext is never stored; legacy rows remain NULL until QR rotation.';

COMMIT;
