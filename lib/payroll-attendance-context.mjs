function assertIsoDate(value, name) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${name} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${name} is not a valid calendar date`);
  }
}

function startOfWeek(isoDate, weekStartsOn) {
  assertIsoDate(isoDate, "isoDate");
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) {
    throw new RangeError("weekStartsOn must be an integer from 0 to 6");
  }
  const date = new Date(`${isoDate}T00:00:00Z`);
  const delta = (date.getUTCDay() - weekStartsOn + 7) % 7;
  date.setUTCDate(date.getUTCDate() - delta);
  return date.toISOString().slice(0, 10);
}

/**
 * Build the minimum attendance query window needed by payroll v0.2.
 *
 * The query starts early enough to include:
 * - the beginning of the statutory week containing the pay-period start; and
 * - the beginning of the configured overtime month for the >60h threshold.
 *
 * The query intentionally ends at the pay-period end. Later days cannot change
 * whether an already-worked payable day crossed a cumulative weekly/monthly threshold.
 */
export function planPayrollAttendanceContext({
  payPeriodStart,
  payPeriodEnd,
  overtimeMonthStart,
  overtimeMonthEnd,
  weekStartsOn = 1,
}) {
  for (const [name, value] of Object.entries({ payPeriodStart, payPeriodEnd, overtimeMonthStart, overtimeMonthEnd })) {
    assertIsoDate(value, name);
  }
  if (payPeriodStart > payPeriodEnd) throw new RangeError("payPeriodStart must be on or before payPeriodEnd");
  if (overtimeMonthStart > overtimeMonthEnd) throw new RangeError("overtimeMonthStart must be on or before overtimeMonthEnd");

  const payPeriodInsideOvertimeMonth = overtimeMonthStart <= payPeriodStart && payPeriodEnd <= overtimeMonthEnd;
  const weekContextStart = startOfWeek(payPeriodStart, weekStartsOn);
  const queryStart = [weekContextStart, overtimeMonthStart].sort()[0];

  return {
    queryPeriod: { start: queryStart, end: payPeriodEnd },
    payPeriod: { start: payPeriodStart, end: payPeriodEnd },
    overtimeMonth: { start: overtimeMonthStart, end: overtimeMonthEnd },
    weekContextStart,
    weekContextComplete: true,
    overtimeMonthContextComplete: payPeriodInsideOvertimeMonth,
    payPeriodInsideOvertimeMonth,
  };
}
