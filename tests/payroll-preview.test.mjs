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

test("preview uses context days for classification but pays only requested period", () => {
  const context = buildPayrollPreviewContext({ payPeriodStart: "2026-08-01", payPeriodEnd: "2026-08-31", settings: baseSettings });
  assert.equal(context.queryPeriod.start, "2026-07-27");
  const result = calculateStaffPayrollPreview({
    attendanceDays: [day("2026-07-27", 480), day("2026-08-01", 480)],
    compensationTerms: [{ id: "term", hourlyRate: 1200, effectiveFrom: "2026-01-01", effectiveTo: null }],
    settings: baseSettings,
    context,
  });
  assert.equal(result.minutes.worked, 480);
  assert.equal(result.components.basePay, 9600);
});

test("calendar month crossing is fail-closed instead of silently confirming", () => {
  const settings = { ...baseSettings, overtimeMonthRule: "CALENDAR_MONTH" };
  const context = buildPayrollPreviewContext({ payPeriodStart: "2026-07-26", payPeriodEnd: "2026-08-25", settings });
  const result = calculateStaffPayrollPreview({ attendanceDays: [day("2026-08-01")], compensationTerms: [{ hourlyRate: 1200, effectiveFrom: "2026-01-01", effectiveTo: null }], settings, context });
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.ok(result.reviewReasons.includes("PAY_PERIOD_CROSSES_OVERTIME_MONTH_BOUNDARY"));
});

test("unknown legal settings stay review-required", () => {
  const settings = { ...baseSettings, overtimeMonthRule: "OTHER_REVIEW_REQUIRED", statutoryHolidayRule: "OTHER_REVIEW_REQUIRED" };
  const context = buildPayrollPreviewContext({ payPeriodStart: "2026-08-01", payPeriodEnd: "2026-08-31", settings });
  const result = calculateStaffPayrollPreview({ attendanceDays: [day("2026-08-01")], compensationTerms: [{ hourlyRate: 1200, effectiveFrom: "2026-01-01", effectiveTo: null }], settings, context });
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.ok(result.reviewReasons.includes("OVERTIME_MONTH_RULE_MISSING"));
  assert.ok(result.reviewReasons.includes("STATUTORY_HOLIDAY_RULE_MISSING"));
});

test("manager preview API is read-only and reuses attendance SSOT", async () => {
  const route = await readFile(new URL("../app/api/manager/payroll/preview/route.ts", import.meta.url), "utf8");
  assert.match(route, /loadMonthlyAttendance/);
  assert.match(route, /aggregateGrossPay|calculateStaffPayrollPreview/);
  assert.match(route, /getSql\(\{ mode: "manager", lineIdentity: identity\.sub, storeId: body\.storeId \}\)/);
  assert.doesNotMatch(route, /INSERT INTO payroll_runs|UPDATE payroll_runs|DELETE FROM payroll_runs/);
  assert.match(route, /persisted: false/);
});

test("preview UI states that result is not saved or finalized", async () => {
  const page = await readFile(new URL("../app/manager/payroll/preview/page.tsx", import.meta.url), "utf8");
  assert.match(page, /保存・確定しません/);
  assert.match(page, /控除前の総支給額/);
  assert.match(page, /要確認/);
});
