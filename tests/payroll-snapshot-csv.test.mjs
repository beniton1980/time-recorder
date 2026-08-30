import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPayrollSnapshotCsv } from "../lib/payroll-snapshot-csv.mjs";

const fixture = {
  storeName: "ONOGAMI,本店",
  run: { id: "11111111-1111-4111-8111-111111111111", period_start: "2026-08-01", period_end: "2026-08-31", saved_at: "2026-09-01T01:00:00Z", version_number: 2 },
  items: [{
    legal_name_snapshot: " =SUM(1,1)\"店長\"\r\n佐藤", hourly_rates_used: [1200, 1300],
    minutes_snapshot: { worked: 600, statutoryOvertime: 60, highOvertime: 0, statutoryHoliday: 30, lateNight: 45 },
    components_snapshot: { basePay: 12000, overtimePremium: 300, highOvertimePremium: 0, statutoryHolidayPremium: 210, lateNightPremium: 150, adjustments: -100, futurePremium: 25 },
    gross_pay_yen: 12585, calculation_spec_version: "payroll-v0.3", source_attendance_spec_versions: ["attendance-v1"],
  }],
};

test("payroll CSV is Excel-friendly, fixed-column and formula-injection safe", () => {
  const csv = createPayrollSnapshotCsv(fixture);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.endsWith("\r\n"));
  assert.match(csv, /"控除前総支給額\(円\)"/);
  assert.match(csv, /"' =SUM\(1,1\)""店長""\r\n佐藤"/);
  assert.match(csv, /"1200 \/ 1300"/);
  assert.match(csv, /"futurePremium=25"/);
  assert.match(csv, /"-100"/);
});

test("payroll CSV API exports only the latest saved snapshot in manager store scope", async () => {
  const route = await readFile(new URL("../app/api/manager/payroll/history/csv/route.ts", import.meta.url), "utf8");
  assert.match(route, /verifyLineIdToken/);
  assert.match(route, /mode: "manager"/);
  assert.match(route, /r\.store_id = \$\{body\.storeId\}::uuid AND r\.id = \$\{body\.runId\}::uuid/);
  assert.match(route, /payroll_run_items/);
  assert.match(route, /PAYROLL_RUN_NOT_LATEST/);
  assert.match(route, /PAYROLL_SNAPSHOT_INCOMPLETE/);
  assert.match(route, /Cache-Control": "no-store"/);
  assert.match(route, /X-Content-Type-Options": "nosniff"/);
  assert.match(route, /text\/csv; charset=utf-8/);
  assert.doesNotMatch(route, /calculatePayrollPreviewForStore|loadMonthlyAttendance/);
});

test("payroll history UI explains the CSV boundary and does not export old versions", async () => {
  const page = await readFile(new URL("../app/manager/payroll/history/page.tsx", import.meta.url), "utf8");
  assert.match(page, /最新版の控除前給与集計をCSV出力/);
  assert.match(page, /税・社会保険等の控除、手取り額、振込情報は含みません/);
  assert.match(page, /以前の保存結果は誤使用を防ぐためCSV出力できません/);
  assert.match(page, /\/api\/manager\/payroll\/history\/csv/);
  assert.match(page, /URL\.revokeObjectURL/);
});
