import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("only an active manager can change a STAFF membership in the same store", async () => {
  const migration = await source("db/migrations/0014_multi_store_manager_boundaries.sql");
  const route = await source("app/api/manager/staff/status/route.ts");
  assert.match(route, /verifyLineIdToken\(body\.idToken\)/);
  assert.match(route, /typeof body\.storeId !== "string"/);
  assert.match(route, /\$\{body\.storeId\}::uuid/);
  assert.match(migration, /st\.role = 'MANAGER'/);
  assert.match(migration, /st\.store_id = p_store_id/);
  assert.match(migration, /st\.role = 'STAFF'/);
});

test("active work blocks deactivation and history is never deleted", async () => {
  const migration = await source("db/migrations/0014_multi_store_manager_boundaries.sql");
  assert.match(migration, /JOIN staff_states ss ON ss\.staff_id = st\.id/);
  assert.doesNotMatch(migration, /LEFT JOIN staff_states ss/);
  assert.match(migration, /FOR UPDATE OF st, ss/);
  assert.match(migration, /target_state IN \('WORKING', 'ON_BREAK'\)/);
  assert.match(migration, /STAFF_ACTIVE_WORK/);
  assert.match(migration, /UPDATE staff st[\s\S]*SET status = p_status/);
  assert.doesNotMatch(migration, /DELETE FROM/);
});

test("staff status changes require the selected store in the manager UI", async () => {
  const page = await source("app/manager/page.tsx");
  assert.match(page, /storeId: dashboard\?\.manager\.store_id/);
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



test("manager dashboard and correction actions stay on the selected store", async () => {
  const dashboard = await source("app/api/manager/dashboard/route.ts");
  const decision = await source("app/api/manager/corrections/decision/route.ts");
  const direct = await source("app/api/manager/punch-corrections/route.ts");
  const page = await source("app/manager/page.tsx");
  assert.match(dashboard, /st\.store_id = \$\{typeof body\.storeId/);
  assert.match(decision, /st\.store_id = \$\{body\.storeId\}::uuid/);
  assert.match(direct, /st\.store_id = \$\{body\.storeId\}::uuid/);
  assert.match(page, /new URLSearchParams\(window\.location\.search\)\.get\("store_id"\)/);
  assert.match(page, /storeId: dashboard\?\.manager\.store_id/);
});

test("multi-store managers can switch stores directly on the dashboard", async () => {
  const page = await source("app/manager/page.tsx");
  assert.match(page, /fetch\("\/api\/manager\/session"/);
  assert.match(page, /managerMemberships\.length > 1/);
  assert.match(page, /表示する店舗/);
  assert.match(page, /void changeStore\(event\.target\.value\)/);
  assert.match(page, /url\.searchParams\.set\("store_id", storeId\)/);
  assert.match(page, /loadDashboard\(undefined, storeId\)/);
  assert.match(page, /loadMonthlyReports\(loadedDashboard\.manager\.store_id\)/);
});
