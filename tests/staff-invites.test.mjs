import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("staff invites are hashed, expiring, revocable, and request-id guarded", async () => {
  const sql = await source("db/migrations/0009_staff_invites.sql");
  assert.match(sql, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(sql, /UNIQUE \(store_id, client_request_id\)/);
  assert.match(sql, /INTERVAL '7 days'/);
  assert.match(sql, /revoked_at IS NULL/);
  assert.doesNotMatch(sql, /raw_token/);
});

test("only an active manager can issue or revoke a store invite", async () => {
  const sql = await source("db/migrations/0009_staff_invites.sql");
  const route = await source("app/api/manager/staff-invites/route.ts");
  assert.match(sql, /creator\.role = 'MANAGER'/);
  assert.match(sql, /creator\.store_id = p_store_id/);
  assert.match(route, /role = 'MANAGER'/);
  assert.match(route, /randomBytes\(32\)/);
  assert.match(route, /hash\(rawToken\)/);
});

test("claim uses verified LINE identity and atomically creates STAFF state", async () => {
  const sql = await source("db/migrations/0009_staff_invites.sql");
  const route = await source("app/api/staff/invite/claim/route.ts");
  assert.match(route, /verifyLineIdToken\(body\.idToken\)/);
  assert.match(route, /tokenHash\(body\.inviteToken\)/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /'STAFF_ALREADY_REGISTERED'/);
  assert.match(sql, /'active', 'STAFF'/);
  assert.match(sql, /INSERT INTO staff_states/);
  assert.match(sql, /SET used_at = NOW\(\)/);
});
