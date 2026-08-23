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

test("an inactive or departed membership cannot self-register again", async () => {
  const bootstrap = await source("app/api/session/bootstrap/route.ts");
  const page = await source("app/page.tsx");
  assert.match(bootstrap, /st\.status IN \('inactive', 'departed'\)/);
  assert.match(bootstrap, /STAFF_INACTIVE/);
  assert.match(page, /この店舗での利用は停止されています/);
});

test("manager dashboard includes every STAFF membership status", async () => {
  const dashboard = await source("app/api/manager/dashboard/route.ts");
  const page = await source("app/manager/page.tsx");
  assert.match(dashboard, /staffMemberships/);
  assert.match(dashboard, /st\.role = 'STAFF'/);
  assert.match(page, /スタッフ管理/);
  assert.match(page, /一時停止/);
  assert.match(page, /利用再開/);
});

test("departed staff are hidden from the normal list without deleting history", async () => {
  const migration = await source("db/migrations/0029_departed_staff.sql");
  const page = await source("app/manager/page.tsx");
  assert.match(migration, /'active', 'inactive', 'departed'/);
  assert.match(migration, /p_status IN \(''active'', ''inactive'', ''departed''\)/);
  assert.doesNotMatch(migration, /DELETE FROM/);
  assert.match(page, /staff\.status !== "departed"/);
  assert.match(page, /退社したスタッフ/);
  assert.match(page, /再雇用/);
});

test("departing a staff member also leaves manager access stopped", async () => {
  const migration = await source("db/migrations/0029_departed_staff.sql");
  assert.match(migration, /UPDATE public\.staff_manager_access access[\s\S]*SET status = ''inactive''/);
  assert.match(migration, /app_manager_store_allowed\(p_store_id\)/);
});

test("a rejected staff status transition returns a visible conflict", async () => {
  const route = await source("app/api/manager/staff/status/route.ts");
  assert.match(route, /rows\.length === 0/);
  assert.match(route, /STAFF_STATUS_NOT_CHANGED/);
});

test("resuming co-manager access offers the LINE guide again", async () => {
  const page = await source("app/manager/page.tsx");
  assert.match(page, /nextStatus === "active"[\s\S]*setCoManagerShare/);
  assert.match(page, /必要に応じて本人へ案内を共有してください/);
});



test("manager dashboard and correction actions stay on the selected store", async () => {
  const dashboard = await source("app/api/manager/dashboard/route.ts");
  const decision = await source("app/api/manager/corrections/decision/route.ts");
  const direct = await source("app/api/manager/punch-corrections/route.ts");
  const page = await source("app/manager/page.tsx");
  assert.match(dashboard, /typeof body\.storeId !== "string" \|\| !uuidPattern\.test\(body\.storeId\)/);
  assert.match(dashboard, /storeId: body\.storeId/);
  assert.match(dashboard, /st\.store_id = \$\{body\.storeId\}::uuid/);
  assert.doesNotMatch(dashboard, /body\.storeId !== undefined/);
  assert.doesNotMatch(dashboard, /::uuid IS NULL/);
  assert.match(decision, /st\.store_id = \$\{body\.storeId\}::uuid/);
  assert.match(direct, /st\.store_id = \$\{body\.storeId\}::uuid/);
  assert.match(page, /new URLSearchParams\(window\.location\.search\)\s*\.get\("store_id"\)/);
  assert.match(page, /if \(!initialStoreId\)/);
  assert.match(page, /JSON\.stringify\(\{ idToken, businessDate, storeId \}\)/);
  assert.match(page, /loadDashboard\(businessDate, dashboard\.manager\.store_id\)/);
  assert.doesNotMatch(page, /await loadDashboard\(selectedDate\);/);
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

test("manager date and time correction fields stay inside the mobile card", async () => {
  const page = await source("app/manager/page.tsx");
  const styles = await source("app/manager/manager.module.css");
  assert.match(styles, /\.resolution select,\s*\.resolution input\s*\{[\s\S]*box-sizing: border-box/);
  assert.match(styles, /\.resolution select,\s*\.resolution input\s*\{[\s\S]*width: auto/);
  assert.match(styles, /\.resolution select,\s*\.resolution input\s*\{[\s\S]*min-width: 0/);
  assert.match(styles, /\.resolution select,\s*\.resolution input\s*\{[\s\S]*justify-self: stretch/);
  assert.match(styles, /\.resolutionDateTime\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(styles, /\.resolutionDateTime label \{ min-width: 0; \}/);
  assert.match(page, /styles\.editPanel/);
  assert.match(page, /role="dialog"/);
  assert.match(styles, /\.editPanel\s*\{[\s\S]*position: fixed/);
  assert.match(styles, /max-height: calc\(100dvh - 24px\)/);
});
