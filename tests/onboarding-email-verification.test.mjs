import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("database blocks manager invites until the approved request email is verified", async () => {
  const migration = await source(
    "db/migrations/0021_verified_onboarding_contact_email.sql",
  );

  assert.match(migration, /contact_email_verification_token_hash TEXT/);
  assert.match(migration, /contact_email_verified_at TIMESTAMPTZ/);
  assert.match(migration, /WHERE contact_email_verification_token_hash IS NOT NULL/);
  assert.match(migration, /SECURITY INVOKER/);
  assert.match(migration, /request\.status = 'APPROVED'/);
  assert.match(migration, /request\.contact_email_verified_at IS NOT NULL/);
  assert.match(migration, /BEFORE INSERT ON public\.onboarding_manager_invites/);
  assert.match(migration, /CONTACT_EMAIL_NOT_VERIFIED/);
  assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC/);
});

test("operator verification delivery stores only a hash and cannot revoke verification", async () => {
  const route = await source(
    "app/api/operator/onboarding/requests/email-verification/route.ts",
  );

  assert.match(route, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(route, /createHash\("sha256"\)/);
  assert.match(route, /INTERVAL '24 hours'/);
  assert.match(route, /contact_email_verified_at IS NULL/);
  assert.doesNotMatch(route, /contact_email_verified_at = NULL/);
  assert.doesNotMatch(route, /rawToken[\s\S]*NextResponse\.json\(\{[\s\S]*rawToken/);
});

test("public verification requires an explicit valid token and consumes it", async () => {
  const route = await source("app/api/onboarding/email-verification/route.ts");
  const page = await source("app/onboarding/verify-email/page.tsx");

  assert.match(route, /export async function POST/);
  assert.match(route, /tokenHash\(body\.token\)/);
  assert.match(route, /contact_email_verification_expires_at > NOW\(\)/);
  assert.match(route, /contact_email_verification_token_hash = NULL/);
  assert.match(page, /onClick=\{\(\)=>void verify\(\)\}/);
  assert.match(page, /history\.replaceState/);
  assert.doesNotMatch(page, /void verify\(\);/);
});

test("verified-email delivery escapes content and uses idempotency", async () => {
  const mailer = await source("lib/onboarding/send-contact-email-verification.ts");
  const provision = await source(
    "app/api/operator/onboarding/requests/provision/route.ts",
  );

  assert.match(mailer, /escapeHtml/);
  assert.match(mailer, /Idempotency-Key/);
  assert.match(mailer, /onboarding-contact-email-/);
  assert.doesNotMatch(mailer, /console\./);
  assert.match(provision, /contact_email_verified_at IS NOT NULL/);
  assert.match(provision, /CONTACT_EMAIL_NOT_VERIFIED/);
});
