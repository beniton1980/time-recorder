BEGIN;

ALTER TABLE public.onboarding_requests
  ADD COLUMN contact_email_verification_token_hash TEXT,
  ADD COLUMN contact_email_verification_expires_at TIMESTAMPTZ,
  ADD COLUMN contact_email_verification_sent_at TIMESTAMPTZ,
  ADD COLUMN contact_email_verified_at TIMESTAMPTZ;

CREATE UNIQUE INDEX uq_onboarding_contact_email_verification_token_hash
  ON public.onboarding_requests(contact_email_verification_token_hash)
  WHERE contact_email_verification_token_hash IS NOT NULL;

ALTER TABLE public.onboarding_requests
  ADD CONSTRAINT onboarding_contact_email_verification_pair
  CHECK (
    (contact_email_verification_token_hash IS NULL)
    = (contact_email_verification_expires_at IS NULL)
  );

CREATE OR REPLACE FUNCTION public.require_verified_onboarding_contact_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.onboarding_requests request
    WHERE request.id = NEW.onboarding_request_id
      AND request.status = 'APPROVED'
      AND request.contact_email_verified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'CONTACT_EMAIL_NOT_VERIFIED';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.require_verified_onboarding_contact_email()
  FROM PUBLIC;

CREATE TRIGGER onboarding_manager_invite_requires_verified_email
BEFORE INSERT ON public.onboarding_manager_invites
FOR EACH ROW
EXECUTE FUNCTION public.require_verified_onboarding_contact_email();

COMMIT;
