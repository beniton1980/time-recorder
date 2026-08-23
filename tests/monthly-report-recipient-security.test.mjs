import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("monthly recipients require database-backed verification and consent evidence", async () => {
  const migration = await source(
    "db/migrations/0022_verified_monthly_report_recipient.sql",
  );

  assert.match(migration, /monthly_report_email_verified_at TIMESTAMPTZ/);
  assert.match(migration, /monthly_report_email_consented_at TIMESTAMPTZ/);
  assert.match(migration, /monthly_report_email_consent_version TEXT/);
  assert.match(migration, /monthly_report_email_updated_by_staff_id UUID/);
  assert.match(migration, /monthly_report_email_verification_token_hash TEXT/);
  assert.match(migration, /WHERE monthly_report_email_verification_token_hash IS NOT NULL/);
  assert.match(migration, /stores_monthly_report_email_confirmation_complete/);
  assert.doesNotMatch(migration, /SET monthly_report_email_verified_at = NOW\(\)[\s\S]*UPDATE public\.onboarding_requests/);
});

test("recipient mutations enforce manager scope and tokens in privileged database functions", async () => {
  const migration = await source(
    "db/migrations/0022_verified_monthly_report_recipient.sql",
  );

  assert.match(migration, /SECURITY DEFINER/g);
  assert.match(migration, /SET search_path = pg_catalog, public/g);
  assert.match(migration, /app_manager_store_allowed\(p_store_id\)/);
  assert.match(migration, /monthly_report_email_verification_expires_at > NOW\(\)/);
  assert.match(migration, /p_consent_version <> '2026-08-21-v1'/);
  assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION[\s\S]*TO onogami_app/);
});

test("manager recipient delivery stores only a hash and never returns the raw token", async () => {
  const route = await source(
    "app/api/manager/monthly-attendance/recipient/route.ts",
  );
  const mailer = await source(
    "lib/send-monthly-report-recipient-verification.ts",
  );

  assert.match(route, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(route, /createHash\("sha256"\)/);
  assert.match(route, /set_monthly_report_recipient/);
  assert.match(route, /mark_monthly_report_verification_sent/);
  assert.doesNotMatch(route, /rawToken[\s\S]*Response\.json\(\{[\s\S]*rawToken/);
  assert.match(mailer, /escapeHtml/);
  assert.match(mailer, /Idempotency-Key/);
  assert.doesNotMatch(mailer, /console\./);
});

test("public confirmation requires explicit consent and a user click", async () => {
  const route = await source(
    "app/api/monthly-attendance/email-verification/route.ts",
  );
  const page = await source("app/monthly-attendance/verify-email/page.tsx");

  assert.match(route, /body\.consent !== true/);
  assert.match(route, /confirm_monthly_report_recipient/);
  assert.match(route, /MONTHLY_REPORT_CONSENT_VERSION/);
  assert.match(page, /type="checkbox"/);
  assert.match(page, /!consent/);
  assert.match(page, /onClick=\{\(\)=>void verify\(\)\}/);
  assert.match(page, /history\.replaceState/);
  assert.doesNotMatch(page, /void verify\(\);/);
});

test("manager UI explains personal data and blocks reissue until confirmation", async () => {
  const page = await source("app/manager/page.tsx");

  assert.match(page, /スタッフ氏名・打刻時刻・勤務時間/);
  assert.match(page, /monthlyRecipientConfirmed/);
  assert.match(page, /!monthlyRecipientConfirmed \|\| reissuingPeriod/);
  assert.match(page, /確認完了まで月次勤怠表は送信されません/);
});

test("recipient generations are append-only and serialize changes with delivery claims", async () => {
  const migration = await source(
    "db/migrations/0023_monthly_report_recipient_generations.sql",
  );

  assert.match(migration, /CREATE TABLE public\.monthly_report_recipient_versions/);
  assert.match(migration, /UNIQUE \(store_id, version_number\)/);
  assert.match(migration, /status IN \('PENDING', 'CONFIRMED', 'REVOKED'\)/);
  assert.match(migration, /monthly_report_recipient_version_id UUID/);
  assert.match(migration, /PERFORM 1 FROM public\.stores WHERE id = p_store_id FOR UPDATE/);
  assert.match(migration, /MONTHLY_REPORT_DELIVERY_IN_PROGRESS/);
  assert.match(migration, /SET status = 'REVOKED'/);
  assert.match(migration, /INSERT INTO public\.monthly_report_recipient_versions/);
  assert.doesNotMatch(migration, /DELETE FROM public\.monthly_report_recipient_versions/);
});

test("delivery attempts retain the actual recipient and use per-attempt idempotency", async () => {
  const migration = await source(
    "db/migrations/0023_monthly_report_recipient_generations.sql",
  );
  const cron = await source("app/api/cron/monthly-attendance/route.ts");
  const reissue = await source(
    "app/api/manager/monthly-attendance/reissue/route.ts",
  );

  assert.match(migration, /CREATE TABLE public\.monthly_attendance_delivery_attempts/);
  assert.match(migration, /recipient_version_id UUID NOT NULL/);
  assert.match(migration, /recipient TEXT NOT NULL/);
  assert.match(migration, /UNIQUE \(delivery_id, attempt_number\)/);
  assert.match(migration, /claim_monthly_attendance_delivery/);
  assert.match(migration, /finish_monthly_attendance_delivery_attempt/);
  assert.match(migration, /FOR UPDATE OF attempt, delivery/);
  assert.match(cron, /`initial-\$\{claimed\[0\]\.attempt_id\}`/);
  assert.match(reissue, /`\$\{version\}-\$\{claimed\[0\]\.attempt_id\}`/);
  assert.doesNotMatch(cron, /recipient = EXCLUDED\.recipient/);
  assert.doesNotMatch(reissue, /recipient = EXCLUDED\.recipient/);
});

test("recipient changes fail closed while a delivery is in progress", async () => {
  const route = await source(
    "app/api/manager/monthly-attendance/recipient/route.ts",
  );
  const page = await source("app/manager/page.tsx");

  assert.match(route, /MONTHLY_REPORT_DELIVERY_IN_PROGRESS/);
  assert.match(route, /status: 409/);
  assert.match(page, /勤怠表を送信中です。送信完了後に送信先を変更してください。/);
});
