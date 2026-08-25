BEGIN;

ALTER TABLE public.store_entry_tokens
  ADD COLUMN IF NOT EXISTS token_ciphertext TEXT;

COMMIT;
