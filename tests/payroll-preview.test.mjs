import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildPayrollPreviewContext, calculateStaffPayrollPreview } from "../lib/payroll-preview.mjs";

const baseSettings = {
  workTimeSystem: "STANDARD_40H",
  weekStartRule: "EXPLICIT_WEEKDAY",
  weekStartsOn: 1,
  overtimeMonthRule: "PAY_PERIOD",
  statutoryHolidayRule: "FIXED_WEEKDAY",
  statutoryHolidayWeekday: 0,
  overtimePremiumRate: 0.25,
  highOvertimePremiumRate: 0.5,
  statutoryHolidayPremiumRate: 0.35,
  lateNightPremiumRate: 0.25,
};

function day(businessDate, workedMinutes = 480) {
  return { staffId: "staff-1", businessDate, status: "CONFIRMED", workedMinutes, lateNightMinutes: 0, calculationSpecVersion: "attendance-v1" };
}

const compensationTerms = [{ id: "term", hourlyRate: 1200, effectiveFrom: "2026-01-01", effectiveTo: null }];

test("preview uses context days for classification but pays only requested period", () => {
  const context = buildPayrollPreviewContext({ payPeriodStart: "2026-08-01", payPeriodEnd: "2026-08-31", settings: baseSettings });
  assert.equal(context.queryPeriod.start, "2026-07-27");
  const result = calculateStaffPayrollPreview({
    attendanceDays: [day("2026-07-27", 480), day("2026-08-01", 480)],
    compensationTerms,
    settings: baseSettings,
    context,
  });
  assert.equal(result.minutes.worked, 480);
  assert.equal(result.components.basePay, 9600);
});

test("calendar month crossing is fail-closed instead of silently confirming", () => {
  const settings = { ...baseSettings, overtimeMonthRule: "CALENDAR_MONTH" };
  const context = buildPayrollPreviewContext({ payPeriodStart: "2026-07-26", payPeriodEnd: "2026-08-25", settings });
  const result = calculateStaffPayrollPreview({ attendanceDays: [day("2026-08-01")], compensationTerms, settings, context });
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.ok(result.reviewReasons.includes("PAY_PERIOD_CROSSES_OVERTIME_MONTH_BOUNDARY"));
});

test("unknown legal settings stay review-required", () => {
  const settings = { ...baseSettings, overtimeMonthRule: "OTHER_REVIEW_REQUIRED", statutoryHolidayRule: "OTHER_REVIEW_REQUIRED" };
  const context = buildPayrollPreviewContext({ payPeriodStart: "2026-08-01", payPeriodEnd: "2026-08-31", settings });
  const result = calculateStaffPayrollPreview({ attendanceDays: [day("2026-08-01")], compensationTerms, settings, context });
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.ok(result.reviewReasons.includes("OVERTIME_MONTH_RULE_MISSING"));
  assert.ok(result.reviewReasons.includes("STATUTORY_HOLIDAY_RULE_MISSING"));
});

test("manual statutory holidays remain review-required until every context month is confirmed", () => {
  const settings = { ...baseSettings, statutoryHolidayRule: "MANUAL_DATES", statutoryHolidayWeekday: null };
  const context = buildPayrollPreviewContext({
    payPeriodStart: "2026-08-01",
    payPeriodEnd: "2026-08-31",
    settings,
    manualHolidayDates: ["2026-08-02", "2026-08-09"],
    manualHolidayConfirmedMonths: ["2026-08"],
  });
  assert.deepEqual(context.unconfirmedManualHolidayMonths, ["2026-07"]);
  assert.equal(context.manualHolidayMonthsComplete, false);
  const result = calculateStaffPayrollPreview({ attendanceDays: [day("2026-08-01")], compensationTerms, settings, context });
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.ok(result.reviewReasons.includes("STATUTORY_HOLIDAY_MONTH_UNCONFIRMED"));
  assert.ok(result.grossPay > 0, "unconfirmed manual holidays should still produce a reference amount");
});

test("manual statutory holidays can confirm after every required context month is reviewed", () => {
  const settings = { ...baseSettings, statutoryHolidayRule: "MANUAL_DATES", statutoryHolidayWeekday: null };
  const context = buildPayrollPreviewContext({
    payPeriodStart: "2026-08-01",
    payPeriodEnd: "2026-08-31",
    settings,
    manualHolidayDates: ["2026-08-02", "2026-08-09"],
    manualHolidayConfirmedMonths: ["2026-07", "2026-08"],
  });
  assert.equal(context.manualHolidayMonthsComplete, true);
  assert.deepEqual(context.unconfirmedManualHolidayMonths, []);
  const result = calculateStaffPayrollPreview({ attendanceDays: [day("2026-08-01")], compensationTerms, settings, context });
  assert.ok(!result.reviewReasons.includes("STATUTORY_HOLIDAY_MONTH_UNCONFIRMED"));
});

test("manager preview API stays read-only while shared service reuses attendance SSOT", async () => {
  const route = await readFile(new URL("../app/api/manager/payroll/preview/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../lib/payroll-preview-server.ts", import.meta.url), "utf8");
  assert.match(route, /calculatePayrollPreviewForStore/);
  assert.match(route, /getSql\(\{ mode: "manager", lineIdentity: identity\.sub, storeId: body\.storeId \}\)/);
  assert.doesNotMatch(route, /INSERT INTO payroll_runs|UPDATE payroll_runs|DELETE FROM payroll_runs/);
  assert.match(route, /persisted: false/);
  assert.match(service, /loadMonthlyAttendance/);
  assert.match(service, /calculateStaffPayrollPreview/);
  assert.match(service, /payroll_statutory_holiday_month_confirmations/);
  assert.match(service, /manualHolidayConfirmedMonths/);
});

test("preview UI distinguishes reference amounts from saved payroll snapshots", async () => {
  const page = await readFile(new URL("../app/manager/payroll/preview/page.tsx", import.meta.url), "utf8");
  assert.match(page, /この給与集計結果を保存/);
  assert.match(page, /保存時にサーバー側でもう一度再計算/);
  assert.match(page, /控除前の総支給額/);
  assert.match(page, /要確認/);
  assert.match(page, /法定休日の確認が必要です/);
  assert.match(page, /unconfirmedManualHolidayMonths/);
});