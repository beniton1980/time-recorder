import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rotationMigrationPath = new URL("../db/migrations/0008_store_qr_issuance.sql", import.meta.url);
const replayMigrationPath = new URL("../db/migrations/0030_store_qr_encrypted_replay.sql", import.meta.url);
const routePath = new URL("../app/api/manager/store-qr/route.ts", import.meta.url);
const encryptionPath = new URL("../lib/store-qr-encryption.ts", import.meta.url);
const onboardingClaimPath = new URL("../app/api/onboarding/manager-invite/claim/route.ts", import.meta.url);

test("QR rotation locks the store and revokes old tokens before insert", async () => {
  const sql = await readFile(rotationMigrationPath, "utf8");
  assert.match(sql, /FROM stores WHERE id = p_store_id[\s\S]*FOR UPDATE/);
  assert.match(sql, /UPDATE store_entry_tokens[\s\S]*active = FALSE/);
  assert.match(sql, /INSERT INTO store_entry_tokens[\s\S]*p_token_hash/);
});

test("reusable QR data is encrypted at rest rather than stored as plaintext", async () => {
  const migration = await readFile(replayMigrationPath, "utf8");
  const encryption = await readFile(encryptionPath, "utf8");
  const route = await readFile(routePath, "utf8");

  assert.match(migration, /token_ciphertext TEXT/);
  assert.match(encryption, /aes-256-gcm/);
  assert.match(encryption, /cipher\.setAAD\(additionalData\(storeId\)\)/);
  assert.match(encryption, /decipher\.setAAD\(additionalData\(storeId\)\)/);
  assert.match(route, /encryptStoreEntryToken\(rawToken, managerStoreId\)/);
  assert.match(route, /hashStoreEntryToken\(rawToken\)/);
  assert.doesNotMatch(migration, /raw_token|plaintext_token/i);
});

test("missing replay key never blocks QR issuance", async () => {
  const encryption = await readFile(encryptionPath, "utf8");
  const route = await readFile(routePath, "utf8");
  const onboarding = await readFile(onboardingClaimPath, "utf8");

  assert.match(encryption, /if \(!encoded\)[\s\S]*if \(required\)[\s\S]*return null/);
  assert.match(encryption, /if \(!key\) return null/);
  assert.match(route, /displayReady: sealedToken !== null/);
  assert.match(route, /打刻用掲示の再表示機能は現在準備中です/);
  assert.match(onboarding, /encryptStoreEntryToken/);
});

test("manager QR API authorizes store membership before display or rotation", async () => {
  const route = await readFile(routePath, "utf8");
  assert.match(route, /st\.role = 'MANAGER'/);
  assert.match(route, /st\.store_id = \$\{body\.storeId\}::uuid/);
  assert.match(route, /"STATUS", "DISPLAY", "ROTATE", "REVOKE"/);
});

test("QR display decrypts only after manager auth and verifies the existing hash", async () => {
  const route = await readFile(routePath, "utf8");
  assert.match(route, /action === "DISPLAY"/);
  assert.match(route, /QR_REISSUE_REQUIRED/);
  assert.match(route, /decryptStoreEntryToken/);
  assert.match(route, /tokenHash !== active\[0\]\.token_hash/);
  assert.match(route, /STORE_QR_CIPHERTEXT|store_qr_ciphertext_integrity_failed|STORE_QR_UNAVAILABLE/);
});

test("rotation stores encrypted replay data in the same database transaction", async () => {
  const route = await readFile(routePath, "utf8");
  assert.match(route, /sql\.transaction/);
  assert.match(route, /rotate_store_entry_token/);
  assert.match(route, /SET token_ciphertext = \$\{sealedToken\}/);
});

test("onboarding-issued QR is also redisplay-ready when replay encryption is configured", async () => {
  const route = await readFile(onboardingClaimPath, "utf8");
  assert.match(route, /encryptStoreEntryToken/);
  assert.match(route, /sql\.transaction/);
  assert.match(route, /SET token_ciphertext = \$\{sealedStoreToken\}/);
});

test("manager QR opens the attendance screen through LIFF", async () => {
  const route = await readFile(routePath, "utf8");
  assert.match(route, /https:\/\/liff\.line\.me\/\$\{LIFF_ID\}\?store_token=/);
  assert.doesNotMatch(route, /new URL\([\s\S]*request\.url/);
});

test("manager QR rotation and display return a directly renderable PNG", async () => {
  const route = await readFile(routePath, "utf8");
  assert.match(route, /QRCode\.toDataURL\(entryUrl/);
  assert.match(route, /qrPngDataUrl/);
});
