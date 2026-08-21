import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("reissue requires the selected manager store and ignores a client recipient", async () => {
  const route = await source("app/api/manager/monthly-attendance/reissue/route.ts");
  assert.match(route, /verifyLineIdToken\(body\.idToken\)/);
  assert.match(route, /st\.role = 'MANAGER'/);
  assert.match(route, /st\.store_id = \$\{body\.storeId\}::uuid/);
  assert.match(route, /recipient: String\(store\.monthly_report_email\)/);
  assert.doesNotMatch(route, /body\.recipient/);
});

test("only a previously sent initial report can be reissued", async () => {
  const route = await source("app/api/manager/monthly-attendance/reissue/route.ts");
  assert.match(route, /delivery_version = 'initial' AND status = 'SENT'/);
  assert.match(route, /MONTHLY_REPORT_NOT_FOUND/);
});

test("request IDs make retries idempotent and failed delivery retryable", async () => {
  const route = await source("app/api/manager/monthly-attendance/reissue/route.ts");
  assert.match(route, /reissue-\$\{body\.requestId\}/);
  assert.match(route, /ON CONFLICT \(store_id, period_start, period_end, delivery_version\)/);
  assert.match(route, /WHERE monthly_attendance_deliveries\.status = 'FAILED'/);
  assert.match(route, /recipient = EXCLUDED\.recipient/);
});

test("report listing is manager-scoped and returns only successful initial periods", async () => {
  const route = await source("app/api/manager/monthly-attendance/reports/route.ts");
  assert.match(route, /st\.line_user_id = \$\{identity\.sub\}/);
  assert.match(route, /st\.store_id = \$\{body\.storeId\}::uuid/);
  assert.match(route, /d\.delivery_version = 'initial' AND d\.status = 'SENT'/);
});

test("manager UI requires confirmation and disables duplicate clicks", async () => {
  const page = await source("app/manager/page.tsx");
  assert.match(page, /window\.confirm/);
  assert.match(page, /crypto\.randomUUID\(\)/);
  assert.match(page, /storeId: dashboard\?\.manager\.store_id/);
  assert.match(page, /disabled=\{!monthlyRecipientConfirmed \|\| reissuingPeriod !== null \|\| exportingPeriod !== null\}/);
  assert.match(page, /再発行して送信/);
});

test("reissue uses only the confirmed and consented store monthly email", async () => {
  const route = await source("app/api/manager/monthly-attendance/reissue/route.ts");
  assert.match(route, /s\.monthly_report_email/);
  assert.match(route, /isConfirmedMonthlyReportRecipient/);
  assert.match(route, /MONTHLY_REPORT_RECIPIENT_NOT_CONFIRMED/);
  assert.doesNotMatch(route, /onboarding_requests/);
});

test("reissue persists only normalized delivery error codes", async () => {
  const route = await source("app/api/manager/monthly-attendance/reissue/route.ts");
  assert.match(route, /monthlyAttendanceDeliveryErrorCode\(error\)/);
  assert.doesNotMatch(route, /error\.message\.slice/);
});
