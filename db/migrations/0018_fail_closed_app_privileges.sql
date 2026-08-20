BEGIN;

-- The four-argument replacement in migration 0014 is the only supported
-- store-scoped staff status function. Remove the legacy overload so it cannot
-- be called through database credentials outside the application route.
DROP FUNCTION IF EXISTS public.set_staff_membership_status(TEXT, UUID, TEXT);

-- Keep only the mutations used by the runtime. Punches are append-only,
-- corrections and delivery attempts are updated in place, and the effective
-- punch view is read-only application output.
REVOKE UPDATE, DELETE ON TABLE public.punch_events FROM onogami_app;
REVOKE DELETE ON TABLE public.correction_requests FROM onogami_app;
REVOKE DELETE ON TABLE public.monthly_attendance_deliveries FROM onogami_app;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.effective_punch_events FROM onogami_app;

-- Future objects must opt in explicitly. This prevents a later migration from
-- silently exposing a new table or function to the production runtime role.
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM onogami_app;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES FROM onogami_app;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM onogami_app;

COMMIT;
