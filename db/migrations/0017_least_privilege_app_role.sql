-- Define a non-login privilege group for the production application.
-- A separate LOGIN role with an independently managed secret should be granted
-- membership in onogami_app during the operational cutover.
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
