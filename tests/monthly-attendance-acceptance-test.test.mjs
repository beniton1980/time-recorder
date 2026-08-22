import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("acceptance test is manager-scoped and never accepts a client recipient", async () => {
  const route = await source("app/api/manager/monthly-attendance/acceptance-test/route.ts");
  assert.match(route, /verifyLineIdToken\(body\.idToken\)/);
  assert.match(route, /st\.role = 'MANAGER'/);
  assert.match(route, /st\.store_id = \$\{body\.storeId\}::uuid/);
  assert.match(route, /recipient: String\(store\.monthly_report_email\)/);
  assert.doesNotMatch(route, /body\.recipient/);
});

test("acceptance test requires a confirmed and consented monthly recipient", async () => {
  const route = await source("app/api/manager/monthly-attendance/acceptance-test/route.ts");
  assert.match(route, /isConfirmedMonthlyReportRecipient\(store\)/);
  assert.match(route, /MONTHLY_REPORT_RECIPIENT_NOT_CONFIRMED/);
  assert.doesNotMatch(route, /onboarding_requests/);
});

test("acceptance test uses production report builders but never claims or finishes a delivery", async () => {
  const route = await source("app/api/manager/monthly-attendance/acceptance-test/route.ts");
  assert.match(route, /loadMonthlyAttendance/);
  assert.match(route, /buildMonthlyAttendanceReport/);
  assert.match(route, /generateMonthlyAttendancePdf/);
  assert.match(route, /sendMonthlyAttendanceEmail/);
  assert.match(route, /acceptanceTest: true/);
  assert.match(route, /acceptance-\$\{body\.requestId\}/);
  assert.doesNotMatch(route, /claim_monthly_attendance_delivery/);
  assert.doesNotMatch(route, /finish_monthly_attendance_delivery_attempt/);
  assert.doesNotMatch(route, /monthly_attendance_deliveries/);
});

test("acceptance test is tightly rate limited", async () => {
  const route = await source("app/api/manager/monthly-attendance/acceptance-test/route.ts");
  assert.match(route, /scope: "manager-monthly-acceptance-test"/);
  assert.match(route, /limit: 3/);
  assert.match(route, /windowSeconds: 600/);
});

test("acceptance test reports safe processing-stage failures", async () => {
  const route = await source("app/api/manager/monthly-attendance/acceptance-test/route.ts");
  assert.match(route, /MONTHLY_AGGREGATION_FAILED/);
  assert.match(route, /MONTHLY_PDF_FAILED/);
  assert.match(route, /monthly_attendance_acceptance_aggregation_failed/);
  assert.match(route, /monthly_attendance_acceptance_pdf_failed/);
  assert.doesNotMatch(route, /error\.message/);
});

test("monthly PDF routes explicitly include bundled Japanese fonts", async () => {
  const config = await source("next.config.ts");
  assert.match(config, /outputFileTracingIncludes/);
  assert.match(config, /"\/\*"\s*:\s*\["\.\/assets\/fonts\/\*\*\/\*\.otf"\]/);
});

test("acceptance email is unmistakably labeled and explains that production delivery is untouched", async () => {
  const email = await source("lib/monthly-attendance-email.mjs");
  assert.match(email, /【受入テスト】/);
  assert.match(email, /本番の月次自動送信や配信履歴には影響しません/);
});
