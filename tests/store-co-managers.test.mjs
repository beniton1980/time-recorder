import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile("db/migrations/0027_store_co_managers.sql", "utf8");
const inviteRoute = await readFile("app/api/manager/co-managers/invite/route.ts", "utf8");
const claimRoute = await readFile("app/api/manager/co-managers/claim/route.ts", "utf8");
const statusRoute = await readFile("app/api/manager/co-managers/status/route.ts", "utf8");
const managerPage = await readFile("app/manager/page.tsx", "utf8");

test("co-manager invitations are selected-store scoped, hashed, expiring, and single-use", () => {
  assert.match(migration, /app_manager_store_allowed\(p_store_id\)/);
  assert.match(migration, /INTERVAL ''7 days''/);
  assert.match(migration, /used_at IS NULL AND invite\.revoked_at IS NULL/);
  assert.match(inviteRoute, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(inviteRoute, /tokenHash\(rawToken\)/);
  assert.doesNotMatch(inviteRoute, /token_hash:\s*rawToken/);
  assert.match(claimRoute, /claim_store_manager_invite/);
});

test("manager status changes prevent self-removal and preserve a final active manager", () => {
  assert.match(migration, /target\.line_user_id <> p_manager_line_user_id/);
  assert.match(migration, /active_manager\.status = ''active''\)'\) > 1|active_manager\.status = ''active''\) > 1/);
  assert.match(statusRoute, /set_store_manager_status/);
});

test("manager UI exposes invitation and store-scoped co-manager controls", () => {
  assert.match(managerPage, /共同管理者/);
  assert.match(managerPage, /dashboard\.manager\.store_id/);
  assert.match(managerPage, /LINEで共有・コピー/);
  assert.match(managerPage, /manager\.is_self/);
});
