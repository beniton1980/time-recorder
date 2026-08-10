import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("manager invites are one-time, expiring, and store only a hash", async () => {
  const schema = await source(
    "db/migrations/0007_onboarding_manager_invites.sql",
  );

  assert.match(schema, /onboarding_request_id UUID NOT NULL UNIQUE/);
  assert.match(schema, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(schema, /expires_at TIMESTAMPTZ NOT NULL/);
  assert.match(schema, /used_at TIMESTAMPTZ/);
  assert.match(schema, /revoked_at TIMESTAMPTZ/);
  assert.doesNotMatch(schema, /raw_token/);
});

test("provisioning is locked, approved-only, and initially suspended", async () => {
  const schema = await source(
    "db/migrations/0007_onboarding_manager_invites.sql",
  );
  const route = await source(
    "app/api/operator/onboarding/requests/provision/route.ts",
  );

  assert.match(schema, /FOR UPDATE/);
  assert.match(schema, /request_row\.status <> 'APPROVED'/);
  assert.match(schema, /'ONBOARDING_REQUEST_ALREADY_PROVISIONED'/);
  assert.match(schema, /'suspended'/);
  assert.match(schema, /INTERVAL '7 days'/);
  assert.match(route, /await verifyOperator\(body\.idToken\)/);
  assert.match(route, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(route, /createHash\("sha256"\)/);
});

test("claim verifies LINE identity and atomically activates the store", async () => {
  const schema = await source(
    "db/migrations/0007_onboarding_manager_invites.sql",
  );
  const route = await source(
    "app/api/onboarding/manager-invite/claim/route.ts",
  );

  assert.match(route, /verifyLineIdToken\(body\.idToken\)/);
  assert.match(route, /tokenHash\(body\.inviteToken\)/);
  assert.doesNotMatch(route, /lineUserId/);
  assert.match(schema, /invite\.used_at IS NULL/);
  assert.match(schema, /invite\.revoked_at IS NULL/);
  assert.match(schema, /invite\.expires_at > NOW\(\)/);
  assert.match(schema, /role\s*\)\s*VALUES[\s\S]*'MANAGER'/);
  assert.match(schema, /SET used_at = NOW\(\)/);
  assert.match(schema, /SET status = 'active'/);
});

test("claim issues the first store QR after activating the manager", async () => {
  const route = await source(
    "app/api/onboarding/manager-invite/claim/route.ts",
  );

  assert.match(route, /rotate_store_entry_token/);
  assert.match(route, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(route, /QRCode\.toDataURL\(entryUrl/);
  assert.match(route, /storeQr = \{ entryUrl, qrPngDataUrl \}/);
  assert.match(route, /catch \(qrError\)/);
  assert.match(route, /return NextResponse\.json\(\{[\s\S]*ok: true,[\s\S]*storeQr/);
});

test("a failed claim cannot partially create manager state", async () => {
  const schema = await source(
    "db/migrations/0007_onboarding_manager_invites.sql",
  );

  assert.match(schema, /CREATE OR REPLACE FUNCTION claim_onboarding_manager_invite/);
  assert.match(schema, /INSERT INTO staff_states/);
  assert.match(schema, /UPDATE onboarding_manager_invites/);
  assert.match(schema, /UPDATE stores/);
  assert.match(schema, /LANGUAGE plpgsql/);
});

test("provisioning emails the invite with idempotency and preserves manual fallback", async () => {
  const route = await source(
    "app/api/operator/onboarding/requests/provision/route.ts",
  );
  const mailer = await source(
    "lib/onboarding/send-manager-invite.ts",
  );

  assert.match(route, /sendManagerInviteMail/);
  assert.match(route, /managerInvite:[\s\S]*url: inviteUrl[\s\S]*email/);
  assert.match(mailer, /process\.env\.RESEND_API_KEY/);
  assert.match(mailer, /process\.env\.RESEND_EMAIL_DOMAIN/);
  assert.match(mailer, /Idempotency-Key/);
  assert.match(mailer, /onboarding-manager-invite-/);
  assert.match(mailer, /no-reply@\$\{domain\}/);
  assert.doesNotMatch(mailer, /console\./);
});
