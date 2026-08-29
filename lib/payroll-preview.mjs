import { aggregateGrossPay } from "./payroll-aggregation.mjs";
import { planPayrollAttendanceContext } from "./payroll-attendance-context.mjs";

function assertIsoDate(value, name) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`${name} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new RangeError(`${name} is invalid`);
}

function monthBounds(isoDate) {
  assertIsoDate(isoDate, "isoDate");
  const date = new Date(`${isoDate}T00:00:00Z`);
  const start = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const endDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return { start, end: endDate.toISOString().slice(0, 10) };
}

function weekdayOf(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

function eachDate(start, end) {
  const dates = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function eachMonth(start, end) {
  const months = [];
  const cursor = new Date(`${start.slice(0, 7)}-01T00:00:00Z`);
  const last = new Date(`${end.slice(0, 7)}-01T00:00:00Z`);
  while (cursor <= last) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function resolveWeekBoundary(settings) {
  if (settings?.weekStartRule === "CALENDAR_DEFAULT") {
    return { weekStartsOn: 0, weekRuleSupported: true };
  }
  if (settings?.weekStartRule === "EXPLICIT_WEEKDAY" && Number.isInteger(settings?.weekStartsOn)
      && settings.weekStartsOn >= 0 && settings.weekStartsOn <= 6) {
    return { weekStartsOn: settings.weekStartsOn, weekRuleSupported: true };
  }
  return { weekStartsOn: 0, weekRuleSupported: false };
}

export function buildPayrollPreviewContext({ payPeriodStart, payPeriodEnd, settings, manualHolidayDates = [], manualHolidayConfirmedMonths = [] }) {
  assertIsoDate(payPeriodStart, "payPeriodStart");
  assertIsoDate(payPeriodEnd, "payPeriodEnd");
  if (payPeriodStart > payPeriodEnd) throw new RangeError("pay period start must not be after end");

  let overtimeMonth;
  let overtimeRuleSupported = true;
  if (settings?.overtimeMonthRule === "PAY_PERIOD") overtimeMonth = { start: payPeriodStart, end: payPeriodEnd };
  else if (settings?.overtimeMonthRule === "CALENDAR_MONTH") overtimeMonth = monthBounds(payPeriodStart);
  else {
    overtimeMonth = { start: payPeriodStart, end: payPeriodEnd };
    overtimeRuleSupported = false;
  }

  const { weekStartsOn, weekRuleSupported } = resolveWeekBoundary(settings);
  const planned = planPayrollAttendanceContext({
    payPeriodStart,
    payPeriodEnd,
    overtimeMonthStart: overtimeMonth.start,
    overtimeMonthEnd: overtimeMonth.end,
    weekStartsOn,
  });

  let statutoryHolidayDates = [];
  let holidayRuleSupported = true;
  let manualHolidayMonthsComplete = true;
  let unconfirmedManualHolidayMonths = [];
  if (settings?.statutoryHolidayRule === "FIXED_WEEKDAY" && Number.isInteger(settings?.statutoryHolidayWeekday)) {
    statutoryHolidayDates = eachDate(planned.queryPeriod.start, planned.queryPeriod.end)
      .filter((date) => weekdayOf(date) === settings.statutoryHolidayWeekday);
  } else if (settings?.statutoryHolidayRule === "MANUAL_DATES") {
    statutoryHolidayDates = manualHolidayDates.filter((date) => planned.queryPeriod.start <= date && date <= planned.queryPeriod.end);
    const confirmed = new Set(manualHolidayConfirmedMonths);
    unconfirmedManualHolidayMonths = eachMonth(planned.queryPeriod.start, planned.queryPeriod.end)
      .filter((month) => !confirmed.has(month));
    manualHolidayMonthsComplete = unconfirmedManualHolidayMonths.length === 0;
  } else {
    holidayRuleSupported = false;
  }

  return {
    ...planned,
    weekStartsOn,
    statutoryHolidayDates,
    overtimeRuleSupported,
    holidayRuleSupported,
    weekRuleSupported,
    manualHolidayMonthsComplete,
    unconfirmedManualHolidayMonths,
  };
}

export function calculateStaffPayrollPreview({ attendanceDays, compensationTerms, settings, context }) {
  const result = aggregateGrossPay({
    attendanceDays,
    compensationTerms,
    settings: {
      workTimeSystem: settings?.workTimeSystem,
      weekStartsOn: context.weekStartsOn,
      weekContextComplete: context.weekContextComplete && context.weekRuleSupported,
      overtimeMonthContextComplete: context.overtimeMonthContextComplete && context.overtimeRuleSupported,
      payPeriodStart: context.payPeriod.start,
      payPeriodEnd: context.payPeriod.end,
      overtimeMonthStart: context.overtimeMonth.start,
      overtimeMonthEnd: context.overtimeMonth.end,
      statutoryHolidayDates: context.holidayRuleSupported ? context.statutoryHolidayDates : undefined,
      overtimePremiumRate: settings?.overtimePremiumRate,
      highOvertimePremiumRate: settings?.highOvertimePremiumRate,
      statutoryHolidayPremiumRate: settings?.statutoryHolidayPremiumRate,
      lateNightPremiumRate: settings?.lateNightPremiumRate,
    },
  });

  return {
    ...result,
    status: result.status === "CONFIRMED" && context.manualHolidayMonthsComplete === false ? "NEEDS_REVIEW" : result.status,
    reviewReasons: [
      ...new Set([
        ...result.reviewReasons,
        ...(context.weekRuleSupported ? [] : ["WEEK_START_RULE_MISSING"]),
        ...(context.overtimeRuleSupported ? [] : ["OVERTIME_MONTH_RULE_MISSING"]),
        ...(context.holidayRuleSupported ? [] : ["STATUTORY_HOLIDAY_RULE_MISSING"]),
        ...(context.manualHolidayMonthsComplete === false ? ["STATUTORY_HOLIDAY_MONTH_UNCONFIRMED"] : []),
      ]),
    ],
  };
}
