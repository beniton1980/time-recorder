import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("a valid store QR can self-register a verified LINE identity", async () => {
  const sql = await source("db/migrations/0009_staff_self_registration.sql");
  const route = await source("app/api/staff/self-register/route.ts");
  assert.match(route, /verifyLineIdToken\(body\.idToken\)/);
  assert.match(route, /hashStoreEntryToken\(body\.storeToken\)/);
  assert.match(sql, /token\.token_hash = p_store_token_hash/);
  assert.match(sql, /token\.active = TRUE/);
  assert.match(sql, /s\.status = 'active'/);
  assert.match(sql, /'active',[\s\S]*'STAFF'/);
  assert.match(sql, /INSERT INTO staff_states/);
});

test("self-registration prevents duplicate store membership but permits other stores", async () => {
  const sql = await source("db/migrations/0009_staff_self_registration.sql");
  assert.match(sql, /staff\.store_id = target_store_id/);
  assert.match(sql, /staff\.line_user_id = p_line_user_id/);
  assert.match(sql, /'STAFF_ALREADY_REGISTERED'/);
  assert.doesNotMatch(sql, /UNIQUE \(line_user_id\)/);
});

test("bootstrap exposes only the valid requested store to unregistered users", async () => {
  const bootstrap = await source("app/api/session/bootstrap/route.ts");
  const page = await source("app/page.tsx");
  assert.match(bootstrap, /SELECT s\.id AS store_id, s\.name AS store_name/);
  assert.match(bootstrap, /registered: false,[\s\S]*store: targetStores\[0\]/);
  assert.match(page, /\/api\/staff\/self-register/);
  assert.match(page, /この店舗に登録する/);
});
