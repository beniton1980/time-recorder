import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL("../db/migrations/0017_least_privilege_app_role.sql", import.meta.url);

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
