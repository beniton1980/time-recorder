import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("cron is daily at 09:00 JST and requires CRON_SECRET", async () => {
  const config = JSON.parse(await source("vercel.json"));
  assert.deepEqual(config.crons, [{ path: "/api/cron/monthly-attendance", schedule: "0 0 * * *" }]);
  const route = await source("app/api/cron/monthly-attendance/route.ts");
  assert.match(route, /Bearer \${process\.env\.CRON_SECRET}/);
});

test("new deliveries select stores whose previous local day was the closing day", async () => {
  const route = await source("app/api/cron/monthly-attendance/route.ts");
  assert.match(route, /AT TIME ZONE s\.timezone/);
  assert.match(route, /s\.closing_rule = 'month_end'/);
  assert.match(route, /s\.closing_rule = 'day_'/);
});

test("failed initial deliveries are selected on later daily runs", async () => {
  const route = await source("app/api/cron/monthly-attendance/route.ts");
  assert.match(route, /d\.delivery_version = 'initial'/);
  assert.match(route, /d\.status = 'FAILED'/);
  assert.match(route, /d\.period_start::text, d\.period_end::text/);
  assert.match(route, /store\.period_start/);
});

test("delivery claims are durable, unique, and recover stale work", async () => {
  const migration = await source("db/migrations/0011_monthly_attendance_deliveries.sql");
  const generations = await source("db/migrations/0023_monthly_report_recipient_generations.sql");
  const route = await source("app/api/cron/monthly-attendance/route.ts");
  assert.match(migration, /UNIQUE \(store_id, period_start, period_end, delivery_version\)/);
  assert.match(route, /claim_monthly_attendance_delivery/);
  assert.match(generations, /SET status = 'PROCESSING'/);
  assert.match(generations, /INTERVAL '15 minutes'/);
  assert.match(generations, /monthly_attendance_delivery_attempts/);
  assert.doesNotMatch(route, /recipient = EXCLUDED\.recipient/);
});

test("runner composes assessment, PDF, and email without changing punch state", async () => {
  const route = await source("app/api/cron/monthly-attendance/route.ts");
  assert.match(route, /loadMonthlyAttendance/);
  assert.match(route, /generateMonthlyAttendancePdf/);
  assert.match(route, /sendMonthlyAttendanceEmail/);
  assert.doesNotMatch(route, /UPDATE staff_states|INSERT INTO punch_events/);
});

test("cron uses only a confirmed and consented store-level recipient", async () => {
  const route = await source("app/api/cron/monthly-attendance/route.ts");
  assert.match(route, /isConfirmedMonthlyReportRecipient/);
  assert.match(route, /s\.monthly_report_email/);
  assert.match(route, /s\.monthly_report_email_verified_at/);
  assert.match(route, /s\.monthly_report_email_consented_at/);
  assert.match(route, /MONTHLY_REPORT_RECIPIENT_NOT_CONFIRMED/);
  assert.match(route, /monthly_report_recipient_version_id/);
  assert.match(route, /recipient: String\(claimed\[0\]\.recipient\)/);
  assert.doesNotMatch(route, /onboarding_requests/);
  assert.doesNotMatch(route, /COALESCE\(/);
});

test("cron persists only normalized delivery error codes", async () => {
  const route = await source("app/api/cron/monthly-attendance/route.ts");
  assert.match(route, /monthlyAttendanceDeliveryErrorCode\(error\)/);
  assert.doesNotMatch(route, /error\.message\.slice/);
});
