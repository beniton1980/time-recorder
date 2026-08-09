import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("only an active manager can change a STAFF membership in the same store", async () => {
  const migration = await source("db/migrations/0010_manager_staff_status.sql");
  const route = await source("app/api/manager/staff/status/route.ts");
  assert.match(route, /verifyLineIdToken\(body\.idToken\)/);
  assert.match(migration, /st\.role = 'MANAGER'/);
  assert.match(migration, /st\.store_id = manager_store_id/);
  assert.match(migration, /st\.role = 'STAFF'/);
});

test("active work blocks deactivation and history is never deleted", async () => {
  const migration = await source("db/migrations/0010_manager_staff_status.sql");
  assert.match(migration, /FOR UPDATE OF st, ss/);
  assert.match(migration, /target_state IN \('WORKING', 'ON_BREAK'\)/);
  assert.match(migration, /STAFF_ACTIVE_WORK/);
  assert.match(migration, /UPDATE staff st[\s\S]*SET status = p_status/);
  assert.doesNotMatch(migration, /DELETE FROM/);
});

test("an inactive membership cannot self-register again", async () => {
  const bootstrap = await source("app/api/session/bootstrap/route.ts");
  const page = await source("app/page.tsx");
  assert.match(bootstrap, /st\.status = 'inactive'/);
  assert.match(bootstrap, /STAFF_INACTIVE/);
  assert.match(page, /この店舗での利用は停止されています/);
});

test("manager dashboard includes active and inactive STAFF memberships", async () => {
  const dashboard = await source("app/api/manager/dashboard/route.ts");
  const page = await source("app/manager/page.tsx");
  assert.match(dashboard, /staffMemberships/);
  assert.match(dashboard, /st\.role = 'STAFF'/);
  assert.match(page, /スタッフ管理/);
  assert.match(page, /利用停止/);
  assert.match(page, /利用再開/);
});

