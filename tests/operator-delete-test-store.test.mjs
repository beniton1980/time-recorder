import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("test store deletion is operator-only and requires exact store-name confirmation", async () => {
  const route = await source(
    "app/api/operator/onboarding/requests/delete/route.ts",
  );
  const page = await source("app/operator/onboarding/page.tsx");

  assert.match(route, /await verifyOperator\(body\.idToken\)/);
  assert.match(route, /confirmationStoreName\.trim\(\)/);
  assert.match(route, /delete_onboarding_test_store/);
  assert.match(page, /window\.prompt/);
  assert.match(page, /confirmationStoreName\.trim\(\) !== item\.store_name/);
  assert.match(page, /元に戻せません/);
  assert.match(page, /テスト店舗データを削除/);
});

test("database deletion is locked to provisioned onboarding stores", async () => {
  const migration = await source(
    "db/migrations/0013_delete_onboarding_test_store.sql",
  );

  assert.match(migration, /FROM onboarding_requests[\s\S]*FOR UPDATE/);
  assert.match(migration, /request_row\.status <> 'PROVISIONED'/);
  assert.match(migration, /request_row\.provisioned_store_id IS NULL/);
  assert.match(migration, /btrim\(p_confirmation_store_name\) <> store_row\.name/);
});

test("stores with business history cannot be deleted", async () => {
  const migration = await source(
    "db/migrations/0013_delete_onboarding_test_store.sql",
  );

  assert.match(migration, /SELECT 1 FROM punch_events WHERE store_id = store_row\.id/);
  assert.match(migration, /SELECT 1 FROM correction_requests WHERE store_id = store_row\.id/);
  assert.match(migration, /SELECT 1 FROM monthly_attendance_deliveries WHERE store_id = store_row\.id/);
  assert.match(migration, /TEST_STORE_HAS_ATTENDANCE_HISTORY/);
});

test("eligible test store relations are deleted in foreign-key-safe order", async () => {
  const migration = await source(
    "db/migrations/0013_delete_onboarding_test_store.sql",
  );

  const states = migration.indexOf("DELETE FROM staff_states");
  const staff = migration.indexOf("DELETE FROM staff\n");
  const tokens = migration.indexOf("DELETE FROM store_entry_tokens");
  const invites = migration.indexOf("DELETE FROM onboarding_manager_invites");
  const request = migration.indexOf("DELETE FROM onboarding_requests");
  const store = migration.indexOf("DELETE FROM stores");

  assert.ok(states >= 0);
  assert.ok(states < staff);
  assert.ok(staff < tokens);
  assert.ok(tokens < invites);
  assert.ok(invites < request);
  assert.ok(request < store);
});
