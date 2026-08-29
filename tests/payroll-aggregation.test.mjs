import test from "node:test";
import assert from "node:assert/strict";
import { aggregateGrossPay } from "../lib/payroll-aggregation.mjs";

const baseSettings = {
  workTimeSystem: "STANDARD_40H",
  weekStartsOn: 1,
  weekContextComplete: true,
  overtimeMonthContextComplete: true,
  statutoryHolidayDates: [],
  payPeriodStart: "2026-08-01",
  payPeriodEnd: "2026-08-31",
  overtimeMonthStart: "2026-08-01",
  overtimeMonthEnd: "2026-08-31",
};

function day(businessDate, workedMinutes, lateNightMinutes = 0, overrides = {}) {
  return {
    storeId: "store-a",
    staffId: "staff-a",
    businessDate,
    status: "CONFIRMED",
    workedMinutes,
    lateNightMinutes,
    calculationSpecVersion: "attendance-v1",
    ...overrides,
  };
}

function terms(hourlyRate = 1200) {
  return [{ id: "term-1", hourlyRate, effectiveFrom: "2026-01-01", effectiveTo: null }];
}

test("regular hours calculate base pay only", () => {
  const result = aggregateGrossPay({ attendanceDays: [day("2026-08-03", 480)], compensationTerms: terms(), settings: baseSettings });
  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.grossPay, 9600);
});

test("daily overtime adds 25 percent premium", () => {
  const result = aggregateGrossPay({ attendanceDays: [day("2026-08-03", 600)], compensationTerms: terms(), settings: baseSettings });
  assert.equal(result.minutes.statutoryOvertime, 120);
  assert.equal(result.components.basePay, 12000);
  assert.equal(result.components.overtimePremium, 600);
});

test("weekly overtime is allocated to the day that crosses the threshold", () => {
  const attendanceDays = [3, 4, 5, 6, 7, 8].map((date) => day(`2026-08-0${date}`, 420));
  const result = aggregateGrossPay({ attendanceDays, compensationTerms: terms(), settings: baseSettings });
  assert.equal(result.minutes.statutoryOvertime, 120);
  assert.equal(result.components.overtimePremium, 600);
});

test("44 hour special week threshold is represented separately", () => {
  const attendanceDays = [3, 4, 5, 6, 7, 8].map((date) => day(`2026-08-0${date}`, 420));
  const result = aggregateGrossPay({ attendanceDays, compensationTerms: terms(), settings: { ...baseSettings, workTimeSystem: "SPECIAL_44H" } });
  assert.equal(result.minutes.statutoryOvertime, 0);
});

test("late night and statutory holiday premiums remain additive", () => {
  const result = aggregateGrossPay({
    attendanceDays: [day("2026-08-09", 600, 120)],
    compensationTerms: terms(),
    settings: { ...baseSettings, statutoryHolidayDates: ["2026-08-09"] },
  });
  assert.equal(result.minutes.statutoryHoliday, 600);
  assert.equal(result.minutes.statutoryOvertime, 0);
  assert.equal(result.components.statutoryHolidayPremium, 4200);
  assert.equal(result.components.lateNightPremium, 600);
});

test("context days outside pay period affect weekly classification but are not paid", () => {
  const result = aggregateGrossPay({
    attendanceDays: [
      day("2026-07-27", 480), day("2026-07-28", 480), day("2026-07-29", 480), day("2026-07-30", 480),
      day("2026-07-31", 480), day("2026-08-01", 480),
    ],
    compensationTerms: terms(),
    settings: {
      ...baseSettings,
      payPeriodStart: "2026-08-01",
      payPeriodEnd: "2026-08-31",
      overtimeMonthStart: "2026-07-01",
      overtimeMonthEnd: "2026-07-31",
    },
  });
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.ok(result.reviewReasons.includes("PAY_PERIOD_CROSSES_OVERTIME_MONTH_BOUNDARY"));
  assert.equal(result.minutes.worked, 480);
  assert.equal(result.components.basePay, 9600);
  assert.equal(result.minutes.statutoryOvertime, 480);
});

test("wage-rate change applies each day's rate to overtime premium", () => {
  const result = aggregateGrossPay({
    attendanceDays: [day("2026-08-03", 540), day("2026-08-04", 540)],
    compensationTerms: [
      { id: "old", hourlyRate: 1200, effectiveFrom: "2026-01-01", effectiveTo: "2026-08-03" },
      { id: "new", hourlyRate: 1300, effectiveFrom: "2026-08-04", effectiveTo: null },
    ],
    settings: baseSettings,
  });
  assert.equal(result.components.basePay, 22500);
  assert.equal(result.components.overtimePremium, 625);
  assert.equal(result.status, "CONFIRMED");
});

test("60 hour threshold is accumulated from overtime month start", () => {
  const attendanceDays = [];
  for (let date = 1; date <= 31; date += 1) {
    const iso = `2026-08-${String(date).padStart(2, "0")}`;
    attendanceDays.push(day(iso, date <= 20 ? 720 : 0));
  }
  const result = aggregateGrossPay({ attendanceDays, compensationTerms: terms(), settings: baseSettings });
  assert.ok(result.minutes.statutoryOvertime > 3600);
  assert.ok(result.minutes.highOvertime > 0);
  assert.ok(result.components.highOvertimePremium > 0);
});

test("missing weekly or overtime-month context prevents confirmation", () => {
  const weekly = aggregateGrossPay({ attendanceDays: [day("2026-08-03", 480)], compensationTerms: terms(), settings: { ...baseSettings, weekContextComplete: false } });
  assert.ok(weekly.reviewReasons.includes("WEEK_CONTEXT_INCOMPLETE"));

  const monthly = aggregateGrossPay({ attendanceDays: [day("2026-08-03", 480)], compensationTerms: terms(), settings: { ...baseSettings, overtimeMonthContextComplete: false } });
  assert.ok(monthly.reviewReasons.includes("OVERTIME_MONTH_CONTEXT_INCOMPLETE"));
});

test("unconfirmed attendance or missing compensation prevents confirmation", () => {
  const attendance = aggregateGrossPay({ attendanceDays: [day("2026-08-03", null, null, { status: "NEEDS_REVIEW" })], compensationTerms: terms(), settings: baseSettings });
  assert.ok(attendance.reviewReasons.includes("ATTENDANCE_NEEDS_REVIEW"));

  const compensation = aggregateGrossPay({ attendanceDays: [day("2026-08-03", 480)], compensationTerms: [], settings: baseSettings });
  assert.ok(compensation.reviewReasons.includes("COMPENSATION_TERM_MISSING_OR_AMBIGUOUS"));
});

test("minute-accurate work is never rounded or truncated", () => {
  const result = aggregateGrossPay({ attendanceDays: [day("2026-08-03", 481)], compensationTerms: terms(1000), settings: baseSettings });
  assert.equal(result.minutes.worked, 481);
  assert.equal(result.components.basePay, 8017);
});

test("ordinary wages round only once at the monthly total and never against the worker", () => {
  const result = aggregateGrossPay({
    attendanceDays: [day("2026-08-03", 1), day("2026-08-04", 1)],
    compensationTerms: terms(1201),
    settings: baseSettings,
  });
  assert.equal(result.minutes.worked, 2);
  assert.equal(result.components.basePay, 41);
});

test("premium yen fractions use exact half-up boundaries", () => {
  const below = aggregateGrossPay({
    attendanceDays: [day("2026-08-03", 481)],
    compensationTerms: terms(119),
    settings: { ...baseSettings, overtimePremiumRate: 0.25 },
  });
  const atBoundary = aggregateGrossPay({
    attendanceDays: [day("2026-08-03", 481)],
    compensationTerms: terms(120),
    settings: { ...baseSettings, overtimePremiumRate: 0.25 },
  });
  assert.equal(below.components.overtimePremium, 0);
  assert.equal(atBoundary.components.overtimePremium, 1);
});

test("ordinary and over-60-hour premiums are rounded once as monthly overtime", () => {
  const attendanceDays = [];
  for (let date = 1; date <= 31; date += 1) {
    attendanceDays.push(day(`2026-08-${String(date).padStart(2, "0")}`, date <= 20 ? 720 : 0));
  }
  const result = aggregateGrossPay({ attendanceDays, compensationTerms: terms(121), settings: baseSettings });
  assert.equal(
    result.components.overtimePremium + result.components.highOvertimePremium,
    Math.floor(((result.minutes.statutoryOvertime - result.minutes.highOvertime) * 121 * 0.25
      + result.minutes.highOvertime * 121 * 0.5) / 60 + 0.5),
  );
});

test("adjustments must already be whole yen", () => {
  assert.throws(
    () => aggregateGrossPay({ attendanceDays: [day("2026-08-03", 480)], compensationTerms: terms(), settings: baseSettings, adjustments: [{ amount: 0.5 }] }),
    /integer yen amount/,
  );
});
