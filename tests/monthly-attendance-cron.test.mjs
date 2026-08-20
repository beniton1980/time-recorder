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
  const route = await source("app/api/cron/monthly-attendance/route.ts");
  assert.match(migration, /UNIQUE \(store_id, period_start, period_end, delivery_version\)/);
  assert.match(route, /ON CONFLICT \(store_id, period_start, period_end, delivery_version\)/);
  assert.match(route, /status = 'FAILED'/);
  assert.match(route, /INTERVAL '15 minutes'/);
});

test("runner composes assessment, PDF, and email without changing punch state", async () => {
  const route = await source("app/api/cron/monthly-attendance/route.ts");
  assert.match(route, /loadMonthlyAttendance/);
  assert.match(route, /generateMonthlyAttendancePdf/);
  assert.match(route, /sendMonthlyAttendanceEmail/);
  assert.doesNotMatch(route, /UPDATE staff_states|INSERT INTO punch_events/);
});

test("store-level monthly report email is preferred with onboarding fallback", async () => {
  const route = await source("app/api/cron/monthly-attendance/route.ts");
  const migration = await source("db/migrations/0012_store_monthly_report_email.sql");
  assert.match(migration, /ADD COLUMN monthly_report_email TEXT/);
  assert.match(route, /COALESCE\(/);
  assert.match(route, /s\.monthly_report_email/);
  assert.match(route, /MONTHLY_REPORT_EMAIL_NOT_CONFIGURED/);
});

test("cron persists only normalized delivery error codes", async () => {
  const route = await source("app/api/cron/monthly-attendance/route.ts");
  assert.match(route, /monthlyAttendanceDeliveryErrorCode\(error\)/);
  assert.doesNotMatch(route, /error\.message\.slice/);
});
