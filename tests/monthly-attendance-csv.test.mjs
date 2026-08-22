import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createMonthlyAttendanceCsv } from "../lib/monthly-attendance-csv.mjs";
import { deriveDailyAttendanceRecords } from "../lib/monthly-attendance.mjs";
import { buildMonthlyAttendanceReport } from "../lib/monthly-attendance-report.mjs";
import { monthlyAttendanceV1Events } from "./fixtures/monthly-attendance-v1.mjs";
const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("CSV is manager-scoped and limited to a sent closing period", async () => {
  const route = await source("app/api/manager/monthly-attendance/csv/route.ts");
  assert.match(route, /verifyLineIdToken\(body\.idToken\)/);
  assert.match(route, /st\.role = 'MANAGER'/);
  assert.match(route, /st\.store_id = \$\{body\.storeId\}::uuid/);
  assert.match(route, /delivery_version = 'initial' AND status = 'SENT'/);
  assert.match(route, /typeof body\.storeId !== "string"/);
});

test("CSV uses the shared daily attendance loader backed by effective punches", async () => {
  const route = await source("app/api/manager/monthly-attendance/csv/route.ts");
  const query = await source("lib/monthly-attendance-query.ts");
  assert.match(route, /loadMonthlyAttendance/);
  assert.match(route, /monthly\.dailyAttendanceRecords/);
  assert.match(route, /createMonthlyAttendanceCsv/);
  assert.match(query, /FROM effective_punch_events epe/);
  assert.match(query, /epe\.business_date BETWEEN/);
  assert.doesNotMatch(query, /st\.status = 'active'/);
});

test("CSV is Excel-friendly and formula-injection safe", async () => {
  const route = await source("app/api/manager/monthly-attendance/csv/route.ts");
  const csv = await source("lib/monthly-attendance-csv.mjs");
  assert.match(csv, /\^\[=\+\\-@\]/);
  assert.match(csv, /\\uFEFF/);
  assert.match(route, /text\/csv; charset=utf-8/);
});

test("GPS reason remains separate and does not remove punches", async () => {
  const calculation = await source("lib/monthly-attendance.mjs");
  const csv = await source("lib/monthly-attendance-csv.mjs");
  assert.match(calculation, /OUTSIDE_STORE_RADIUS/);
  assert.match(calculation, /LOW_GPS_ACCURACY/);
  assert.match(calculation, /CLIENT_LOCATION_UNAVAILABLE/);
  assert.match(calculation, /STORE_LOCATION_UNAVAILABLE/);
  assert.match(csv, /GPS確認/);
});

test("CSV daily values equal the v1 daily attendance records", () => {
  const events = monthlyAttendanceV1Events.filter((event) => event.store_id === "store-a");
  const days = deriveDailyAttendanceRecords(events);
  const report = buildMonthlyAttendanceReport({
    storeName: "小料理屋ひなた",
    timezone: "Asia/Tokyo",
    label: "8月度",
    period: { start: "2026-08-01", end: "2026-08-31" },
    generatedAt: new Date("2026-09-01T00:00:00Z"),
    events,
    days,
  });
  const csv = createMonthlyAttendanceCsv(report);
  assert.match(csv, /"2026-08-01","佐藤 健","0:45","5:30","1:10","確定"/);
  assert.match(csv, /"2026-08-05","佐藤 健","","","","要確認","退勤の打刻がありません"/);
  assert.match(csv, /"2026-08-07","佐藤 健","0:00","4:00","0:00","確定","GPS確認1件"/);
});

test("manager UI exposes CSV only as an action on completed periods", async () => {
  const page = await source("app/manager/page.tsx");
  assert.match(page, /monthlyReports\.map/);
  assert.match(page, /periodEnd: report\.period_end/);
  assert.match(page, /storeId: dashboard\?\.manager\.store_id/);
  assert.match(page, /補助CSV/);
  assert.doesNotMatch(page, /type="month"/);
});

