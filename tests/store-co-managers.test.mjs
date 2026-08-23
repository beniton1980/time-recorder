import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile("db/migrations/0028_staff_manager_access.sql", "utf8");
const accessRoute = await readFile("app/api/manager/co-managers/access/route.ts", "utf8");
const managerPage = await readFile("app/manager/page.tsx", "utf8");
const managerSession = await readFile("app/api/manager/session/route.ts", "utf8");

test("co-manager access is selected-store scoped and separate from employment", () => {
  assert.match(migration, /app_manager_store_allowed\(p_store_id\)/);
  assert.match(migration, /CREATE TABLE public\.staff_manager_access/);
  assert.match(migration, /role = ''STAFF'' AND line_user_id/);
  assert.match(accessRoute, /set_staff_manager_access/);
  assert.match(managerSession, /access\.status = 'active'/);
});

test("manager status changes prevent self-removal and preserve a final active manager", () => {
  assert.match(migration, /line_user_id <> p_manager_line_user_id/);
  assert.match(migration, /active_access\.status = ''active''/);
  assert.match(migration, /\) > 1/);
});

test("manager UI selects an existing staff member without name re-entry", () => {
  assert.match(managerPage, /共同管理者/);
  assert.match(managerPage, /dashboard\.manager\.store_id/);
  assert.match(managerPage, /登録済みスタッフを選択/);
  assert.match(managerPage, /coManagerCandidates\.map/);
  assert.doesNotMatch(managerPage, /招待リンクを発行/);
  assert.match(managerPage, /manager\.is_self/);
});
