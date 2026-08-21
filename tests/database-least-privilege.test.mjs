import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL("../db/migrations/0017_least_privilege_app_role.sql", import.meta.url);
const hardeningPath = new URL("../db/migrations/0018_fail_closed_app_privileges.sql", import.meta.url);
const recipientGenerationsPath = new URL(
  "../db/migrations/0023_monthly_report_recipient_generations.sql",
  import.meta.url,
);

test("application database role cannot own or administer the database", async () => {
  const migration = await readFile(migrationPath, "utf8");
  assert.match(migration, /CREATE ROLE onogami_app NOLOGIN/);
  assert.match(migration, /NOSUPERUSER NOCREATEDB NOCREATEROLE/);
  assert.match(migration, /NOREPLICATION NOBYPASSRLS/);
  assert.doesNotMatch(migration, /GRANT (CREATE|ALL).*TO onogami_app/i);
});

test("application role receives data access but custom functions are closed to public", async () => {
  const migration = await readFile(migrationPath, "utf8");
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES/);
  assert.match(migration, /REVOKE ALL ON FUNCTION %s FROM PUBLIC/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION %s TO onogami_app/);
  assert.match(migration, /consume_api_rate_limit/);
  assert.match(migration, /delete_onboarding_test_store/);
});

test("future owner-created objects preserve least privilege defaults", async () => {
  const migration = await readFile(migrationPath, "utf8");
  assert.match(migration, /ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner/);
  assert.match(migration, /REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTIONS TO onogami_app/);
});

test("legacy multi-store function overload is removed", async () => {
  const migration = await readFile(hardeningPath, "utf8");
  assert.match(
    migration,
    /DROP FUNCTION IF EXISTS public\.set_staff_membership_status\(TEXT, UUID, TEXT\)/,
  );
  assert.doesNotMatch(
    migration,
    /DROP FUNCTION IF EXISTS public\.set_staff_membership_status\(TEXT, UUID, UUID, TEXT\)/,
  );
});

test("append-only and derived attendance data cannot be mutated unnecessarily", async () => {
  const migration = await readFile(hardeningPath, "utf8");
  assert.match(migration, /REVOKE UPDATE, DELETE ON TABLE public\.punch_events/);
  assert.match(migration, /REVOKE DELETE ON TABLE public\.correction_requests/);
  assert.match(migration, /REVOKE DELETE ON TABLE public\.monthly_attendance_deliveries/);
  assert.match(
    migration,
    /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.effective_punch_events/,
  );
});

test("future database objects fail closed until explicitly granted", async () => {
  const migration = await readFile(hardeningPath, "utf8");
  assert.match(
    migration,
    /REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM onogami_app/,
  );
  assert.match(migration, /REVOKE USAGE, SELECT ON SEQUENCES FROM onogami_app/);
  assert.match(migration, /REVOKE EXECUTE ON FUNCTIONS FROM onogami_app/);
  assert.doesNotMatch(migration, /GRANT .* ON (TABLES|SEQUENCES|FUNCTIONS)/);
});

test("recipient generations and delivery attempts are function-only records", async () => {
  const migration = await readFile(recipientGenerationsPath, "utf8");
  assert.match(migration, /REVOKE ALL ON TABLE public\.monthly_report_recipient_versions FROM PUBLIC/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.monthly_attendance_delivery_attempts FROM PUBLIC/);
  assert.doesNotMatch(migration, /GRANT .* ON TABLE public\.monthly_report_recipient_versions/);
  assert.doesNotMatch(migration, /GRANT .* ON TABLE public\.monthly_attendance_delivery_attempts/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.claim_monthly_attendance_delivery[\s\S]*FROM PUBLIC/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.claim_monthly_attendance_delivery[\s\S]*TO onogami_app/);
});
