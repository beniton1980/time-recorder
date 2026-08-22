import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("test store archival is operator-only and requires exact store-name confirmation", async () => {
  const route = await source(
    "app/api/operator/onboarding/requests/delete/route.ts",
  );
  const page = await source("app/operator/onboarding/page.tsx");

  assert.match(route, /await verifyOperator\(body\.idToken\)/);
  assert.match(route, /confirmationStoreName\.trim\(\)/);
  assert.match(route, /delete_onboarding_test_store/);
  assert.match(route, /archivedStore/);
  assert.match(page, /window\.prompt/);
  assert.match(page, /confirmationStoreName\.trim\(\) !== item\.store_name/);
  assert.match(page, /監査のため保持され/);
  assert.match(page, /テスト店舗を無効化/);
});

test("database archival is locked to active provisioned onboarding stores", async () => {
  const migration = await source(
    "db/migrations/0025_logical_delete_onboarding_test_store.sql",
  );

  assert.match(migration, /FROM public\.onboarding_requests[\s\S]*FOR UPDATE/);
  assert.match(migration, /archived_at IS NULL/);
  assert.match(migration, /request_row\.status <> 'PROVISIONED'/);
  assert.match(migration, /request_row\.provisioned_store_id IS NULL/);
  assert.match(migration, /btrim\(p_confirmation_store_name\) <> store_row\.name/);
});

test("stores with business history cannot be archived through test cleanup", async () => {
  const migration = await source(
    "db/migrations/0025_logical_delete_onboarding_test_store.sql",
  );

  assert.match(migration, /SELECT 1 FROM public\.punch_events WHERE store_id = store_row\.id/);
  assert.match(migration, /SELECT 1 FROM public\.correction_requests WHERE store_id = store_row\.id/);
  assert.match(migration, /SELECT 1 FROM public\.monthly_attendance_deliveries WHERE store_id = store_row\.id/);
  assert.match(migration, /TEST_STORE_HAS_ATTENDANCE_HISTORY/);
});

test("eligible test stores are disabled while audit evidence is retained", async () => {
  const migration = await source(
    "db/migrations/0025_logical_delete_onboarding_test_store.sql",
  );

  assert.match(migration, /SET active = FALSE, revoked_at = COALESCE\(revoked_at, NOW\(\)\)/);
  assert.match(migration, /SET revoked_at = COALESCE\(revoked_at, NOW\(\)\)/);
  assert.match(migration, /SET status = 'inactive', updated_at = NOW\(\)/);
  assert.match(migration, /SET status = 'closed', deleted_at = NOW\(\), updated_at = NOW\(\)/);
  assert.match(migration, /SET archived_at = NOW\(\), updated_at = NOW\(\)/);
  assert.doesNotMatch(migration, /DELETE FROM|TRUNCATE|DROP TABLE/i);
});

test("archived onboarding requests disappear from the operator work queue", async () => {
  const route = await source("app/api/operator/onboarding/requests/route.ts");

  assert.match(route, /WHERE status = \$\{status\}[\s\S]*AND archived_at IS NULL/);
});
