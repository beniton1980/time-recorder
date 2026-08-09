import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL("../db/migrations/0008_store_qr_issuance.sql", import.meta.url);
const routePath = new URL("../app/api/manager/store-qr/route.ts", import.meta.url);

test("QR rotation locks the store and revokes old tokens before insert", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /FROM stores WHERE id = p_store_id[\s\S]*FOR UPDATE/);
  assert.match(sql, /UPDATE store_entry_tokens[\s\S]*active = FALSE/);
  assert.match(sql, /INSERT INTO store_entry_tokens[\s\S]*p_token_hash/);
});

test("manager QR API authorizes store membership and never stores the raw token", async () => {
  const route = await readFile(routePath, "utf8");
  assert.match(route, /st\.role = 'MANAGER'/);
  assert.match(route, /st\.store_id = \$\{body\.storeId\}::uuid/);
  assert.match(route, /randomBytes\(32\)/);
  assert.match(route, /hashToken\(rawToken\)/);
  assert.doesNotMatch(route, /INSERT INTO store_entry_tokens/);
});

test("rotation and revocation are separate explicit actions", async () => {
  const route = await readFile(routePath, "utf8");
  assert.match(route, /"STATUS", "ROTATE", "REVOKE"/);
  assert.match(route, /revoke_store_entry_tokens/);
  assert.match(route, /rotate_store_entry_token/);
});
