import test from "node:test";
import assert from "node:assert/strict";
import { aggregateGrossPay } from "../lib/payroll-aggregation.mjs";

const baseSettings = {
  workTimeSystem: "STANDARD_40H",
  weekStartsOn: 1,
  weekContextComplete: true,
  statutoryHolidayDates: [],
  roundingMode: "ROUND",
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
  const result = aggregateGrossPay({
    attendanceDays: [day("2026-08-03", 8 * 60)],
    compensationTerms: terms(1200),
    settings: baseSettings,
  });
  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.grossPay, 9600);
  assert.equal(result.components.overtimePremium, 0);
});

test("daily overtime adds 25 percent premium", () => {
  const result = aggregateGrossPay({
    attendanceDays: [day("2026-08-03", 10 * 60)],
    compensationTerms: terms(1200),
    settings: baseSettings,
  });
  assert.equal(result.minutes.statutoryOvertime, 120);
  assert.equal(result.components.basePay, 12000);
  assert.equal(result.components.overtimePremium, 600);
  assert.equal(result.grossPay, 12600);
});

test("weekly overtime adds only minutes not already counted as daily overtime", () => {
  const attendanceDays = [3, 4, 5, 6, 7, 8].map((date) => day(`2026-08-0${date}`, 7 * 60));
  const result = aggregateGrossPay({
    attendanceDays,
    compensationTerms: terms(1200),
    settings: baseSettings,
  });
  assert.equal(result.minutes.statutoryOvertime, 120);
  assert.equal(result.components.overtimePremium, 600);
});

test("44 hour special week threshold is represented separately", () => {
  const attendanceDays = [3, 4, 5, 6, 7, 8].map((date) => day(`2026-08-0${date}`, 7 * 60));
  const result = aggregateGrossPay({
    attendanceDays,
    compensationTerms: terms(1200),
    settings: { ...baseSettings, workTimeSystem: "SPECIAL_44H" },
  });
  assert.equal(result.minutes.statutoryOvertime, 0);
  assert.equal(result.status, "CONFIRMED");
});

test("late night premium is additive", () => {
  const result = aggregateGrossPay({
    attendanceDays: [day("2026-08-03", 8 * 60, 2 * 60)],
    compensationTerms: terms(1200),
    settings: baseSettings,
  });
  assert.equal(result.components.basePay, 9600);
  assert.equal(result.components.lateNightPremium, 600);
  assert.equal(result.grossPay, 10200);
});

test("statutory holiday premium is additive and holiday minutes are not overtime", () => {
  const result = aggregateGrossPay({
    attendanceDays: [day("2026-08-09", 10 * 60, 2 * 60)],
    compensationTerms: terms(1200),
    settings: { ...baseSettings, statutoryHolidayDates: ["2026-08-09"] },
  });
  assert.equal(result.minutes.statutoryHoliday, 600);
  assert.equal(result.minutes.statutoryOvertime, 0);
  assert.equal(result.components.statutoryHolidayPremium, 4200);
  assert.equal(result.components.lateNightPremium, 600);
  assert.equal(result.grossPay, 16800);
});

test("more than 60 hours of statutory overtime uses the higher premium for the excess", () => {
  const attendanceDays = [];
  for (let week = 0; week < 4; week += 1) {
    for (let offset = 0; offset < 6; offset += 1) {
      const date = new Date(Date.UTC(2026, 7, 3 + week * 7 + offset));
      attendanceDays.push(day(date.toISOString().slice(0, 10), 11 * 60));
    }
  }
  const result = aggregateGrossPay({
    attendanceDays,
    compensationTerms: terms(1200),
    settings: baseSettings,
  });
  assert.ok(result.minutes.statutoryOvertime > 60 * 60);
  assert.ok(result.minutes.highOvertime > 0);
  assert.ok(result.components.highOvertimePremium > 0);
});

test("missing weekly context prevents confirmation", () => {
  const result = aggregateGrossPay({
    attendanceDays: [day("2026-08-03", 8 * 60)],
    compensationTerms: terms(),
    settings: { ...baseSettings, weekContextComplete: false },
  });
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.ok(result.reviewReasons.includes("WEEK_CONTEXT_INCOMPLETE"));
});

test("unconfirmed attendance prevents payroll confirmation", () => {
  const result = aggregateGrossPay({
    attendanceDays: [day("2026-08-03", null, null, { status: "NEEDS_REVIEW" })],
    compensationTerms: terms(),
    settings: baseSettings,
  });
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.ok(result.reviewReasons.includes("ATTENDANCE_NEEDS_REVIEW"));
});

test("missing compensation term prevents confirmation", () => {
  const result = aggregateGrossPay({
    attendanceDays: [day("2026-08-03", 8 * 60)],
    compensationTerms: [],
    settings: baseSettings,
  });
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.ok(result.reviewReasons.includes("COMPENSATION_TERM_MISSING_OR_AMBIGUOUS"));
});

test("wage-rate change preserves base pay and refuses ambiguous overtime premium", () => {
  const result = aggregateGrossPay({
    attendanceDays: [day("2026-08-03", 9 * 60), day("2026-08-04", 9 * 60)],
    compensationTerms: [
      { id: "old", hourlyRate: 1200, effectiveFrom: "2026-01-01", effectiveTo: "2026-08-03" },
      { id: "new", hourlyRate: 1300, effectiveFrom: "2026-08-04", effectiveTo: null },
    ],
    settings: baseSettings,
  });
  assert.equal(result.components.basePay, 22500);
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.ok(result.reviewReasons.includes("OVERTIME_WITH_MULTIPLE_WAGE_RATES_REQUIRES_REVIEW"));
});
