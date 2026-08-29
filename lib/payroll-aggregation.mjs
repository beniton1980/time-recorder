export const PAYROLL_CALCULATION_SPEC_VERSION = "2026-08-29-v0.3";

const MINUTES_PER_DAY = 8 * 60;
const STANDARD_WEEKLY_MINUTES = 40 * 60;
const SPECIAL_WEEKLY_MINUTES = 44 * 60;
const HIGH_OVERTIME_THRESHOLD_MINUTES = 60 * 60;

function assertNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
}

function assertRate(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
}

function assertIsoDate(value, name) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${name} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${name} is not a valid calendar date`);
  }
}

function weekThresholdMinutes(workTimeSystem) {
  if (workTimeSystem === "STANDARD_40H") return STANDARD_WEEKLY_MINUTES;
  if (workTimeSystem === "SPECIAL_44H") return SPECIAL_WEEKLY_MINUTES;
  return null;
}

function weekKey(isoDate, weekStartsOn = 1) {
  assertIsoDate(isoDate, "businessDate");
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) {
    throw new RangeError("weekStartsOn must be an integer from 0 (Sun) to 6 (Sat)");
  }
  const date = new Date(`${isoDate}T00:00:00Z`);
  const delta = (date.getUTCDay() - weekStartsOn + 7) % 7;
  date.setUTCDate(date.getUTCDate() - delta);
  return date.toISOString().slice(0, 10);
}

function compensationForDate(terms, businessDate) {
  const matches = terms.filter((term) => {
    assertIsoDate(term.effectiveFrom, "effectiveFrom");
    if (term.effectiveTo != null) assertIsoDate(term.effectiveTo, "effectiveTo");
    return term.effectiveFrom <= businessDate && (term.effectiveTo == null || businessDate <= term.effectiveTo);
  });
  return matches.length === 1 ? matches[0] : null;
}

const RATE_SCALE = 100_000;
const YEN_DENOMINATOR = BigInt(60 * RATE_SCALE);

function rateUnits(rate, name) {
  assertRate(rate, name);
  const units = Math.round(rate * RATE_SCALE);
  if (!Number.isSafeInteger(units) || Math.abs(rate - units / RATE_SCALE) > 1e-10) {
    throw new RangeError(`${name} must have at most five decimal places`);
  }
  return BigInt(units);
}

function yenNumeratorForMinutes(hourlyRate, minutes, multiplierUnits = BigInt(RATE_SCALE)) {
  assertNonNegativeInteger(hourlyRate, "hourlyRate");
  return BigInt(hourlyRate) * BigInt(minutes) * multiplierUnits;
}

function safeYen(value, name) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new RangeError(`${name} exceeds the safe yen range`);
  return amount;
}

// Work time remains minute-accurate. Ordinary wages are rounded only once at the
// monthly total and always in the worker's favor. Statutory premium categories use
// the permitted half-up convention at their monthly totals. Integer arithmetic
// keeps exact 0.50-yen boundaries independent of floating-point representation.
function ceilYen(numerator, name) {
  return safeYen((numerator + YEN_DENOMINATOR - 1n) / YEN_DENOMINATOR, name);
}

function roundYenHalfUp(numerator, name) {
  return safeYen((numerator * 2n + YEN_DENOMINATOR) / (YEN_DENOMINATOR * 2n), name);
}

function isWithin(date, start, end) {
  return start <= date && date <= end;
}

/**
 * Aggregate attendance into gross pay.
 *
 * attendanceDays may include context days outside the pay period. Those days are
 * used only to classify weekly/monthly statutory overtime and are never paid by
 * this result. Taxes, social insurance, resident tax and net pay remain out of scope.
 */
export function aggregateGrossPay({ attendanceDays, compensationTerms, settings, adjustments = [] }) {
  if (!Array.isArray(attendanceDays) || !Array.isArray(compensationTerms) || !Array.isArray(adjustments)) {
    throw new TypeError("attendanceDays, compensationTerms and adjustments must be arrays");
  }

  const reviewReasons = new Set();
  const weeklyThreshold = weekThresholdMinutes(settings?.workTimeSystem);
  if (weeklyThreshold == null) reviewReasons.add("UNSUPPORTED_WORK_TIME_SYSTEM");
  if (settings?.weekContextComplete !== true) reviewReasons.add("WEEK_CONTEXT_INCOMPLETE");
  if (settings?.overtimeMonthContextComplete !== true) reviewReasons.add("OVERTIME_MONTH_CONTEXT_INCOMPLETE");
  if (!Array.isArray(settings?.statutoryHolidayDates)) reviewReasons.add("STATUTORY_HOLIDAY_RULE_MISSING");

  const payPeriodStart = settings?.payPeriodStart;
  const payPeriodEnd = settings?.payPeriodEnd;
  const overtimeMonthStart = settings?.overtimeMonthStart;
  const overtimeMonthEnd = settings?.overtimeMonthEnd;
  for (const [name, value] of Object.entries({ payPeriodStart, payPeriodEnd, overtimeMonthStart, overtimeMonthEnd })) {
    if (value == null) reviewReasons.add("PAYROLL_PERIOD_CONTEXT_MISSING");
    else assertIsoDate(value, name);
  }
  if (payPeriodStart && payPeriodEnd && payPeriodStart > payPeriodEnd) throw new RangeError("payPeriodStart must be on or before payPeriodEnd");
  if (overtimeMonthStart && overtimeMonthEnd && overtimeMonthStart > overtimeMonthEnd) throw new RangeError("overtimeMonthStart must be on or before overtimeMonthEnd");
  if (payPeriodStart && payPeriodEnd && overtimeMonthStart && overtimeMonthEnd
      && (!isWithin(payPeriodStart, overtimeMonthStart, overtimeMonthEnd)
        || !isWithin(payPeriodEnd, overtimeMonthStart, overtimeMonthEnd))) {
    reviewReasons.add("PAY_PERIOD_CROSSES_OVERTIME_MONTH_BOUNDARY");
  }

  const statutoryHolidayDates = new Set(settings?.statutoryHolidayDates ?? []);
  for (const value of statutoryHolidayDates) assertIsoDate(value, "statutoryHolidayDate");

  const weekStartsOn = settings?.weekStartsOn ?? 1;
  const overtimePremiumRate = settings?.overtimePremiumRate ?? 0.25;
  const highOvertimePremiumRate = settings?.highOvertimePremiumRate ?? 0.5;
  const statutoryHolidayPremiumRate = settings?.statutoryHolidayPremiumRate ?? 0.35;
  const lateNightPremiumRate = settings?.lateNightPremiumRate ?? 0.25;
  for (const [name, rate] of Object.entries({ overtimePremiumRate, highOvertimePremiumRate, statutoryHolidayPremiumRate, lateNightPremiumRate })) {
    assertRate(rate, name);
  }
  const overtimePremiumUnits = rateUnits(overtimePremiumRate, "overtimePremiumRate");
  const highOvertimePremiumUnits = rateUnits(highOvertimePremiumRate, "highOvertimePremiumRate");
  const statutoryHolidayPremiumUnits = rateUnits(statutoryHolidayPremiumRate, "statutoryHolidayPremiumRate");
  const lateNightPremiumUnits = rateUnits(lateNightPremiumRate, "lateNightPremiumRate");

  const orderedDays = [...attendanceDays].sort((a, b) => String(a.businessDate).localeCompare(String(b.businessDate)));
  const lines = [];

  for (const day of orderedDays) {
    assertIsoDate(day.businessDate, "businessDate");
    if (day.status !== "CONFIRMED" || day.workedMinutes == null || day.lateNightMinutes == null) {
      reviewReasons.add("ATTENDANCE_NEEDS_REVIEW");
      continue;
    }
    assertNonNegativeInteger(day.workedMinutes, "workedMinutes");
    assertNonNegativeInteger(day.lateNightMinutes, "lateNightMinutes");
    if (day.lateNightMinutes > day.workedMinutes) throw new RangeError("lateNightMinutes cannot exceed workedMinutes");

    const term = compensationForDate(compensationTerms, day.businessDate);
    if (!term) {
      reviewReasons.add("COMPENSATION_TERM_MISSING_OR_AMBIGUOUS");
      continue;
    }
    assertNonNegativeInteger(term.hourlyRate, "hourlyRate");

    const statutoryHoliday = statutoryHolidayDates.has(day.businessDate);
    const dailyOvertimeMinutes = statutoryHoliday ? 0 : Math.max(0, day.workedMinutes - MINUTES_PER_DAY);
    const weeklyCandidateMinutes = statutoryHoliday ? 0 : day.workedMinutes - dailyOvertimeMinutes;
    lines.push({
      businessDate: day.businessDate,
      staffId: day.staffId,
      workedMinutes: day.workedMinutes,
      lateNightMinutes: day.lateNightMinutes,
      statutoryHoliday,
      dailyOvertimeMinutes,
      weeklyCandidateMinutes,
      weeklyExcessMinutes: 0,
      statutoryOvertimeMinutes: 0,
      highOvertimeMinutes: 0,
      hourlyRate: term.hourlyRate,
      compensationTermId: term.id ?? null,
      payable: Boolean(payPeriodStart && payPeriodEnd && isWithin(day.businessDate, payPeriodStart, payPeriodEnd)),
    });
  }

  // Allocate weekly excess to the day on which the weekly threshold is crossed.
  if (weeklyThreshold != null) {
    const runningByWeek = new Map();
    for (const line of lines) {
      const key = weekKey(line.businessDate, weekStartsOn);
      const before = runningByWeek.get(key) ?? 0;
      const after = before + line.weeklyCandidateMinutes;
      line.weeklyExcessMinutes = Math.max(0, after - weeklyThreshold) - Math.max(0, before - weeklyThreshold);
      line.statutoryOvertimeMinutes = line.dailyOvertimeMinutes + line.weeklyExcessMinutes;
      runningByWeek.set(key, after);
    }
  } else {
    for (const line of lines) line.statutoryOvertimeMinutes = line.dailyOvertimeMinutes;
  }

  // The 60-hour threshold is accumulated from the configured statutory overtime
  // month start, not assumed to match the payroll closing period.
  let overtimeMonthRunningMinutes = 0;
  for (const line of lines) {
    if (!overtimeMonthStart || !overtimeMonthEnd || !isWithin(line.businessDate, overtimeMonthStart, overtimeMonthEnd)) continue;
    const before = overtimeMonthRunningMinutes;
    const after = before + line.statutoryOvertimeMinutes;
    line.highOvertimeMinutes = Math.max(0, after - HIGH_OVERTIME_THRESHOLD_MINUTES) - Math.max(0, before - HIGH_OVERTIME_THRESHOLD_MINUTES);
    overtimeMonthRunningMinutes = after;
  }

  let totalWorkedMinutes = 0;
  let totalLateNightMinutes = 0;
  let statutoryHolidayMinutes = 0;
  let statutoryOvertimeMinutes = 0;
  let highOvertimeMinutes = 0;
  let basePayNumerator = 0n;
  let overtimePremiumNumerator = 0n;
  let highOvertimePremiumNumerator = 0n;
  let statutoryHolidayPremiumNumerator = 0n;
  let lateNightPremiumNumerator = 0n;

  for (const line of lines.filter((value) => value.payable)) {
    totalWorkedMinutes += line.workedMinutes;
    totalLateNightMinutes += line.lateNightMinutes;
    statutoryOvertimeMinutes += line.statutoryOvertimeMinutes;
    highOvertimeMinutes += line.highOvertimeMinutes;
    if (line.statutoryHoliday) statutoryHolidayMinutes += line.workedMinutes;

    basePayNumerator += yenNumeratorForMinutes(line.hourlyRate, line.workedMinutes);
    lateNightPremiumNumerator += yenNumeratorForMinutes(line.hourlyRate, line.lateNightMinutes, lateNightPremiumUnits);
    if (line.statutoryHoliday) {
      statutoryHolidayPremiumNumerator += yenNumeratorForMinutes(line.hourlyRate, line.workedMinutes, statutoryHolidayPremiumUnits);
    }
    const ordinaryOvertime = line.statutoryOvertimeMinutes - line.highOvertimeMinutes;
    overtimePremiumNumerator += yenNumeratorForMinutes(line.hourlyRate, ordinaryOvertime, overtimePremiumUnits);
    highOvertimePremiumNumerator += yenNumeratorForMinutes(line.hourlyRate, line.highOvertimeMinutes, highOvertimePremiumUnits);
  }

  let adjustmentTotal = 0;
  for (const adjustment of adjustments) {
    if (!Number.isSafeInteger(adjustment.amount)) throw new TypeError("adjustment.amount must be an integer yen amount");
    adjustmentTotal += adjustment.amount;
  }

  const roundedOvertimePremium = roundYenHalfUp(overtimePremiumNumerator, "overtimePremium");
  const roundedCombinedOvertimePremium = roundYenHalfUp(
    overtimePremiumNumerator + highOvertimePremiumNumerator,
    "combinedOvertimePremium",
  );
  const components = {
    basePay: ceilYen(basePayNumerator, "basePay"),
    overtimePremium: roundedOvertimePremium,
    highOvertimePremium: roundedCombinedOvertimePremium - roundedOvertimePremium,
    statutoryHolidayPremium: roundYenHalfUp(statutoryHolidayPremiumNumerator, "statutoryHolidayPremium"),
    lateNightPremium: roundYenHalfUp(lateNightPremiumNumerator, "lateNightPremium"),
    adjustments: adjustmentTotal,
  };

  return {
    status: reviewReasons.size === 0 ? "CONFIRMED" : "NEEDS_REVIEW",
    reviewReasons: [...reviewReasons],
    minutes: {
      worked: totalWorkedMinutes,
      statutoryOvertime: statutoryOvertimeMinutes,
      highOvertime: highOvertimeMinutes,
      statutoryHoliday: statutoryHolidayMinutes,
      lateNight: totalLateNightMinutes,
    },
    components,
    grossPay: Object.values(components).reduce((sum, value) => sum + value, 0),
    calculationSpecVersion: PAYROLL_CALCULATION_SPEC_VERSION,
    sourceAttendanceSpecVersions: [...new Set(attendanceDays.map((day) => day.calculationSpecVersion).filter(Boolean))],
  };
}
