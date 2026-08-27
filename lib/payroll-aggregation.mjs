export const PAYROLL_CALCULATION_SPEC_VERSION = "2026-08-27-v0.1";

const MINUTES_PER_DAY = 8 * 60;
const STANDARD_WEEKLY_MINUTES = 40 * 60;
const SPECIAL_WEEKLY_MINUTES = 44 * 60;
const HIGH_OVERTIME_THRESHOLD_MINUTES = 60 * 60;

function assertNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
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

function yenFromMinuteRate(hourlyRate, minutes, multiplier = 1) {
  return (hourlyRate * minutes * multiplier) / 60;
}

function roundYen(value, roundingMode) {
  if (roundingMode === "FLOOR") return Math.floor(value);
  if (roundingMode === "CEIL") return Math.ceil(value);
  if (roundingMode === "ROUND") return Math.round(value);
  throw new RangeError(`Unsupported rounding mode: ${roundingMode}`);
}

function compensationForDate(terms, businessDate) {
  const matches = terms.filter((term) => {
    assertIsoDate(term.effectiveFrom, "effectiveFrom");
    if (term.effectiveTo != null) assertIsoDate(term.effectiveTo, "effectiveTo");
    return term.effectiveFrom <= businessDate && (term.effectiveTo == null || businessDate <= term.effectiveTo);
  });
  if (matches.length !== 1) return null;
  return matches[0];
}

/**
 * Aggregate confirmed attendance into a gross-pay preview.
 *
 * This engine intentionally stops at gross pay. Taxes, social insurance,
 * resident tax, net pay and statutory payroll documents are out of scope.
 *
 * Attendance is expected to come from deriveDailyAttendanceRecords().
 */
export function aggregateGrossPay({
  attendanceDays,
  compensationTerms,
  settings,
  adjustments = [],
}) {
  if (!Array.isArray(attendanceDays) || !Array.isArray(compensationTerms) || !Array.isArray(adjustments)) {
    throw new TypeError("attendanceDays, compensationTerms and adjustments must be arrays");
  }

  const weeklyThreshold = weekThresholdMinutes(settings?.workTimeSystem);
  const reviewReasons = new Set();
  if (weeklyThreshold == null) reviewReasons.add("UNSUPPORTED_WORK_TIME_SYSTEM");
  if (settings?.weekContextComplete !== true) reviewReasons.add("WEEK_CONTEXT_INCOMPLETE");
  if (!Array.isArray(settings?.statutoryHolidayDates)) reviewReasons.add("STATUTORY_HOLIDAY_RULE_MISSING");

  const statutoryHolidayDates = new Set(settings?.statutoryHolidayDates ?? []);
  for (const value of statutoryHolidayDates) assertIsoDate(value, "statutoryHolidayDate");

  const weekStartsOn = settings?.weekStartsOn ?? 1;
  const overtimePremiumRate = settings?.overtimePremiumRate ?? 0.25;
  const highOvertimePremiumRate = settings?.highOvertimePremiumRate ?? 0.5;
  const statutoryHolidayPremiumRate = settings?.statutoryHolidayPremiumRate ?? 0.35;
  const lateNightPremiumRate = settings?.lateNightPremiumRate ?? 0.25;
  const roundingMode = settings?.roundingMode ?? "ROUND";

  for (const [name, rate] of Object.entries({
    overtimePremiumRate,
    highOvertimePremiumRate,
    statutoryHolidayPremiumRate,
    lateNightPremiumRate,
  })) assertRate(rate, name);

  const weeks = new Map();
  const lines = [];
  let totalWorkedMinutes = 0;
  let totalLateNightMinutes = 0;
  let statutoryHolidayMinutes = 0;
  let dailyOvertimeMinutes = 0;

  const orderedDays = [...attendanceDays].sort((a, b) =>
    String(a.businessDate).localeCompare(String(b.businessDate))
    || String(a.staffId).localeCompare(String(b.staffId)),
  );

  for (const day of orderedDays) {
    assertIsoDate(day.businessDate, "businessDate");
    if (day.status !== "CONFIRMED" || day.workedMinutes == null || day.lateNightMinutes == null) {
      reviewReasons.add("ATTENDANCE_NEEDS_REVIEW");
      continue;
    }
    assertNonNegativeInteger(day.workedMinutes, "workedMinutes");
    assertNonNegativeInteger(day.lateNightMinutes, "lateNightMinutes");
    if (day.lateNightMinutes > day.workedMinutes) {
      throw new RangeError("lateNightMinutes cannot exceed workedMinutes");
    }

    const term = compensationForDate(compensationTerms, day.businessDate);
    if (!term) {
      reviewReasons.add("COMPENSATION_TERM_MISSING_OR_AMBIGUOUS");
      continue;
    }
    assertRate(term.hourlyRate, "hourlyRate");

    const isStatutoryHoliday = statutoryHolidayDates.has(day.businessDate);
    const dailyOvertime = isStatutoryHoliday ? 0 : Math.max(0, day.workedMinutes - MINUTES_PER_DAY);
    const regularForWeekly = isStatutoryHoliday ? 0 : day.workedMinutes - dailyOvertime;
    const key = weekKey(day.businessDate, weekStartsOn);
    const week = weeks.get(key) ?? { regularForWeeklyMinutes: 0, dailyOvertimeMinutes: 0 };
    week.regularForWeeklyMinutes += regularForWeekly;
    week.dailyOvertimeMinutes += dailyOvertime;
    weeks.set(key, week);

    totalWorkedMinutes += day.workedMinutes;
    totalLateNightMinutes += day.lateNightMinutes;
    if (isStatutoryHoliday) statutoryHolidayMinutes += day.workedMinutes;
    dailyOvertimeMinutes += dailyOvertime;

    lines.push({
      businessDate: day.businessDate,
      staffId: day.staffId,
      workedMinutes: day.workedMinutes,
      lateNightMinutes: day.lateNightMinutes,
      statutoryHoliday: isStatutoryHoliday,
      hourlyRate: term.hourlyRate,
      compensationTermId: term.id ?? null,
    });
  }

  let weeklyExcessMinutes = 0;
  if (weeklyThreshold != null) {
    for (const week of weeks.values()) {
      weeklyExcessMinutes += Math.max(0, week.regularForWeeklyMinutes - weeklyThreshold);
    }
  }

  const statutoryOvertimeMinutes = dailyOvertimeMinutes + weeklyExcessMinutes;
  const highOvertimeMinutes = Math.max(0, statutoryOvertimeMinutes - HIGH_OVERTIME_THRESHOLD_MINUTES);
  const ordinaryOvertimeMinutes = statutoryOvertimeMinutes - highOvertimeMinutes;

  let basePayUnrounded = 0;
  let lateNightPremiumUnrounded = 0;
  let statutoryHolidayPremiumUnrounded = 0;
  for (const line of lines) {
    basePayUnrounded += yenFromMinuteRate(line.hourlyRate, line.workedMinutes);
    lateNightPremiumUnrounded += yenFromMinuteRate(line.hourlyRate, line.lateNightMinutes, lateNightPremiumRate);
    if (line.statutoryHoliday) {
      statutoryHolidayPremiumUnrounded += yenFromMinuteRate(
        line.hourlyRate,
        line.workedMinutes,
        statutoryHolidayPremiumRate,
      );
    }
  }

  // Overtime may span multiple wage rates. v0.1 refuses to guess in that case.
  const overtimeRates = new Set(lines.filter((line) => !line.statutoryHoliday).map((line) => line.hourlyRate));
  let overtimePremiumUnrounded = 0;
  let highOvertimePremiumUnrounded = 0;
  if (statutoryOvertimeMinutes > 0) {
    if (overtimeRates.size !== 1) {
      reviewReasons.add("OVERTIME_WITH_MULTIPLE_WAGE_RATES_REQUIRES_REVIEW");
    } else {
      const [hourlyRate] = overtimeRates;
      overtimePremiumUnrounded = yenFromMinuteRate(hourlyRate, ordinaryOvertimeMinutes, overtimePremiumRate);
      highOvertimePremiumUnrounded = yenFromMinuteRate(hourlyRate, highOvertimeMinutes, highOvertimePremiumRate);
    }
  }

  let adjustmentTotal = 0;
  for (const adjustment of adjustments) {
    if (typeof adjustment.amount !== "number" || !Number.isFinite(adjustment.amount)) {
      throw new TypeError("adjustment.amount must be a finite number");
    }
    adjustmentTotal += adjustment.amount;
  }

  const components = {
    basePay: roundYen(basePayUnrounded, roundingMode),
    overtimePremium: roundYen(overtimePremiumUnrounded, roundingMode),
    highOvertimePremium: roundYen(highOvertimePremiumUnrounded, roundingMode),
    statutoryHolidayPremium: roundYen(statutoryHolidayPremiumUnrounded, roundingMode),
    lateNightPremium: roundYen(lateNightPremiumUnrounded, roundingMode),
    adjustments: roundYen(adjustmentTotal, roundingMode),
  };

  const grossPay = Object.values(components).reduce((sum, value) => sum + value, 0);
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
    grossPay,
    calculationSpecVersion: PAYROLL_CALCULATION_SPEC_VERSION,
    sourceAttendanceSpecVersions: [...new Set(attendanceDays.map((day) => day.calculationSpecVersion).filter(Boolean))],
  };
}
