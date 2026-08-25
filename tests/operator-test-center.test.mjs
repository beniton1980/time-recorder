import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildTestCenterScenario, testCenterEvents } from "../lib/test-center/scenario.mjs";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("test center synthetic scenario reuses attendance and artifact builders", () => {
  const scenario = buildTestCenterScenario();
  assert.equal(scenario.days.filter((day) => day.status === "NEEDS_REVIEW").length, 1);
  assert.equal(scenario.gpsIssues.length, 1);
  assert.match(scenario.csv, /営業日/);
  assert.match(scenario.email.subject, /受入テスト/);
  assert.ok(testCenterEvents.some((item) => item.store_id === "test-store-b"));
  assert.ok(scenario.storeEvents.every((item) => item.store_id === "test-store-a"));
});

test("operator test center is allowlist protected and has no production mutation or email delivery", async () => {
  const run = await source("app/api/operator/test-center/run/route.ts");
  const artifact = await source("app/api/operator/test-center/artifact/route.ts");
  assert.match(run, /verifyOperator\(body\.idToken\)/);
  assert.match(artifact, /verifyOperator\(body\.idToken\)/);
  for (const code of [run, artifact]) {
    assert.doesNotMatch(code, /getSql|sendMonthlyAttendanceEmail|sendInitialStoreQrMail|RESEND_API_KEY|\/api\/manager\/store-qr/);
  }
});

test("test center UI names destructive exclusions and manual checks", async () => {
  const page = await source("app/operator/test-center/page.tsx");
  assert.match(page, /安全な全自動テストを実行/);
  assert.match(page, /実メール送信・QR再発行/);
  assert.match(page, /実機確認/);
  assert.match(page, /月次メール/);
  assert.match(page, /PDF表示/);
  assert.match(page, /CSV表示/);
  assert.match(page, /① メール確認/);
  assert.match(page, /② 管理者登録/);
  assert.match(page, /③ 利用開始/);
  assert.match(page, /掲示用チラシ/);
});

test("onboarding mail previews use the same pure builders as delivery", async () => {
  const artifact = await source("app/api/operator/test-center/artifact/route.ts");
  const contact = await source("lib/onboarding/send-contact-email-verification.ts");
  const manager = await source("lib/onboarding/send-manager-invite.ts");
  const start = await source("lib/onboarding/send-initial-store-qr.ts");
  assert.match(artifact, /createContactEmailVerificationMail/);
  assert.match(artifact, /createManagerInviteMail/);
  assert.match(artifact, /createInitialStoreQrMail/);
  assert.match(contact, /const content = createContactEmailVerificationMail\(mail\)/);
  assert.match(manager, /const content = createManagerInviteMail\(mail\)/);
  assert.match(start, /const content = createInitialStoreQrMail\(mail\)/);
  assert.doesNotMatch(artifact, /fetch\("https:\/\/api\.resend\.com/);
  assert.match(artifact, /\/manager\?store_id=00000000-0000-4000-8000-000000000001/);
  assert.match(artifact, /\/onboarding\/invite\?token=PREVIEW/);
  assert.match(artifact, /generateStorePosterPdf/);
  assert.match(artifact, /body\.type === "onboarding-poster"/);
});
