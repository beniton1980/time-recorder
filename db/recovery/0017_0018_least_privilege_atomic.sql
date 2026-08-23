\set ON_ERROR_STOP on

-- Recovery/new-environment application unit for migrations 0017 and 0018.
-- Do not apply 0017 or 0018 separately when rebuilding an environment.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'onogami_app') THEN
    CREATE ROLE onogami_app NOLOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE neondb TO onogami_app;
GRANT USAGE ON SCHEMA public TO onogami_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO onogami_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO onogami_app;

DO $$
DECLARE
  app_function regprocedure;
BEGIN
  FOR app_function IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY[
        'claim_onboarding_manager_invite',
        'consume_api_rate_limit',
        'delete_onboarding_test_store',
        'provision_onboarding_request',
        'revoke_store_entry_tokens',
        'rotate_store_entry_token',
        'self_register_staff',
        'set_staff_membership_status'
      ])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', app_function);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO onogami_app', app_function);
  END LOOP;
END
$$;

ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO onogami_app;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO onogami_app;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO onogami_app;

DROP FUNCTION IF EXISTS public.set_staff_membership_status(TEXT, UUID, TEXT);

REVOKE UPDATE, DELETE ON TABLE public.punch_events FROM onogami_app;
REVOKE DELETE ON TABLE public.correction_requests FROM onogami_app;
REVOKE DELETE ON TABLE public.monthly_attendance_deliveries FROM onogami_app;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.effective_punch_events FROM onogami_app;

ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM onogami_app;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES FROM onogami_app;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM onogami_app;

COMMIT;
