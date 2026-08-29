import { loadMonthlyAttendance } from "@/lib/monthly-attendance-query";
import { buildPayrollPreviewContext, calculateStaffPayrollPreview } from "@/lib/payroll-preview.mjs";

type WeekStartRule = "CALENDAR_DEFAULT" | "EXPLICIT_WEEKDAY" | "OTHER_REVIEW_REQUIRED";
type SettingsRow = {
  work_time_system: string;
  week_start_rule: string;
  week_starts_on: number;
  overtime_month_rule: string;
  statutory_holiday_rule: string;
  statutory_holiday_weekday: number | null;
  overtime_premium_rate: number;
  high_overtime_premium_rate: number;
  statutory_holiday_premium_rate: number;
  late_night_premium_rate: number;
};
type StaffRow = {
  staff_id: string;
  legal_name: string;
  status: string;
  other_employment_status: "NONE" | "HAS_OTHER_EMPLOYER" | "UNKNOWN" | null;
  other_employment_confirmed_at: string | null;
  other_employment_confirmation_current: boolean;
};
type TermRow = { id: string; staff_id: string; hourly_rate_yen: number; effective_from: string; effective_to: string | null };
type CompensationTerm = { id: string; hourlyRate: number; effectiveFrom: string; effectiveTo: string | null };

function normalizeWeekStartRule(value: string | undefined): WeekStartRule {
  if (value === "CALENDAR_DEFAULT" || value === "EXPLICIT_WEEKDAY") return value;
  return "OTHER_REVIEW_REQUIRED";
}

function hourlyRatesUsed(days: Array<{ businessDate: string; workedMinutes: number | null }>, terms: CompensationTerm[], payStart: string, payEnd: string) {
  const rates = new Set<number>();
  for (const day of days) {
    if (day.businessDate < payStart || day.businessDate > payEnd || day.workedMinutes == null) continue;
    const matches = terms.filter((term) => term.effectiveFrom <= day.businessDate && (term.effectiveTo == null || day.businessDate <= term.effectiveTo));
    if (matches.length === 1) rates.add(matches[0].hourlyRate);
  }
  return [...rates].sort((a, b) => a - b);
}

export async function calculatePayrollPreviewForStore(sql: any, storeId: string, periodStart: string, periodEnd: string) {
  const [settingsRows, staffRows, termRows, manualHolidayRows, manualHolidayConfirmationRows] = await Promise.all([
    sql`
      SELECT work_time_system, week_start_rule, week_starts_on, overtime_month_rule,
        statutory_holiday_rule, statutory_holiday_weekday,
        overtime_premium_rate::float8 AS overtime_premium_rate,
        high_overtime_premium_rate::float8 AS high_overtime_premium_rate,
        statutory_holiday_premium_rate::float8 AS statutory_holiday_premium_rate,
        late_night_premium_rate::float8 AS late_night_premium_rate
      FROM payroll_store_settings
      WHERE store_id = ${storeId}::uuid
    `,
    sql`
      SELECT st.id AS staff_id, st.legal_name, st.status,
        confirmation.status AS other_employment_status,
        confirmation.confirmed_at::text AS other_employment_confirmed_at,
        COALESCE(confirmation.confirmed_at >= NOW() - INTERVAL '6 months', false) AS other_employment_confirmation_current
      FROM staff st
      LEFT JOIN staff_other_employment_confirmations confirmation
        ON confirmation.store_id = st.store_id AND confirmation.staff_id = st.id
      WHERE st.store_id = ${storeId}::uuid
        AND st.status IN ('active', 'inactive')
      ORDER BY st.status ASC, st.created_at ASC
    `,
    sql`
      SELECT id, staff_id, hourly_rate_yen, effective_from::text, effective_to::text
      FROM payroll_compensation_terms
      WHERE store_id = ${storeId}::uuid
      ORDER BY staff_id, effective_from ASC
    `,
    sql`
      SELECT holiday_date::text AS holiday_date
      FROM payroll_statutory_holidays
      WHERE store_id = ${storeId}::uuid
        AND holiday_date BETWEEN ${periodStart}::date - INTERVAL '40 days' AND ${periodEnd}::date
      ORDER BY holiday_date
    `,
    sql`
      SELECT to_char(holiday_month, 'YYYY-MM') AS holiday_month
      FROM payroll_statutory_holiday_month_confirmations
      WHERE store_id = ${storeId}::uuid
        AND holiday_month BETWEEN date_trunc('month', (${periodStart}::date - INTERVAL '40 days'))::date
                              AND date_trunc('month', ${periodEnd}::date)::date
      ORDER BY holiday_month
    `,
  ]);

  const row = (settingsRows[0] ?? null) as SettingsRow | null;
  const settings = {
    workTimeSystem: row?.work_time_system ?? "OTHER_REVIEW_REQUIRED",
    weekStartRule: normalizeWeekStartRule(row?.week_start_rule),
    weekStartsOn: row?.week_starts_on ?? 0,
    overtimeMonthRule: row?.overtime_month_rule ?? "OTHER_REVIEW_REQUIRED",
    statutoryHolidayRule: row?.statutory_holiday_rule ?? "OTHER_REVIEW_REQUIRED",
    statutoryHolidayWeekday: row?.statutory_holiday_weekday ?? null,
    overtimePremiumRate: row?.overtime_premium_rate ?? 0.25,
    highOvertimePremiumRate: row?.high_overtime_premium_rate ?? 0.50,
    statutoryHolidayPremiumRate: row?.statutory_holiday_premium_rate ?? 0.35,
    lateNightPremiumRate: row?.late_night_premium_rate ?? 0.25,
  };
  const context = buildPayrollPreviewContext({
    payPeriodStart: periodStart,
    payPeriodEnd: periodEnd,
    settings,
    manualHolidayDates: manualHolidayRows.map((value: { holiday_date: string }) => String(value.holiday_date)),
    manualHolidayConfirmedMonths: manualHolidayConfirmationRows.map((value: { holiday_month: string }) => String(value.holiday_month)),
  });
  const monthly = await loadMonthlyAttendance(sql as never, storeId, context.queryPeriod);
  const staff = staffRows as StaffRow[];
  const terms = termRows as TermRow[];

  const results = staff.map((member) => {
    const memberDays = monthly.days.filter((day) => day.staffId === member.staff_id);
    const memberTerms: CompensationTerm[] = terms.filter((term) => term.staff_id === member.staff_id).map((term) => ({
      id: term.id,
      hourlyRate: Number(term.hourly_rate_yen),
      effectiveFrom: term.effective_from,
      effectiveTo: term.effective_to,
    }));
    const calculated = calculateStaffPayrollPreview({ attendanceDays: memberDays, compensationTerms: memberTerms, settings, context });
    const otherEmploymentReason = member.other_employment_status == null
      ? "OTHER_EMPLOYMENT_UNCONFIRMED"
      : !member.other_employment_confirmation_current
        ? "OTHER_EMPLOYMENT_CONFIRMATION_EXPIRED"
        : member.other_employment_status === "HAS_OTHER_EMPLOYER"
          ? "OTHER_EMPLOYMENT_PRESENT"
          : member.other_employment_status === "UNKNOWN"
            ? "OTHER_EMPLOYMENT_UNKNOWN"
            : null;
    const reviewReasons = [...new Set([...calculated.reviewReasons, ...(otherEmploymentReason ? [otherEmploymentReason] : [])])];
    const preview = {
      ...calculated,
      status: calculated.status === "CONFIRMED" && otherEmploymentReason ? "NEEDS_REVIEW" as const : calculated.status,
      reviewReasons,
    };
    const payableDayCount = memberDays.filter((day) => context.payPeriod.start <= day.businessDate && day.businessDate <= context.payPeriod.end && day.workedMinutes != null).length;
    return {
      staffId: member.staff_id,
      legalName: member.legal_name,
      staffStatus: member.status,
      payableDayCount,
      hourlyRatesUsed: hourlyRatesUsed(memberDays, memberTerms, context.payPeriod.start, context.payPeriod.end),
      otherEmployment: {
        status: member.other_employment_status,
        confirmedAt: member.other_employment_confirmed_at,
        confirmationCurrent: member.other_employment_confirmation_current,
      },
      ...preview,
    };
  });

  const visible = results.filter((result) => result.payableDayCount > 0 || result.staffStatus === "active");
  return {
    period: context.payPeriod,
    settings,
    rates: {
      overtimePremiumRate: settings.overtimePremiumRate,
      highOvertimePremiumRate: settings.highOvertimePremiumRate,
      statutoryHolidayPremiumRate: settings.statutoryHolidayPremiumRate,
      lateNightPremiumRate: settings.lateNightPremiumRate,
    },
    context: {
      queryPeriod: context.queryPeriod,
      overtimeMonth: context.overtimeMonth,
      payPeriodInsideOvertimeMonth: context.payPeriodInsideOvertimeMonth,
      weekRuleSupported: context.weekRuleSupported,
      manualHolidayMonthsComplete: context.manualHolidayMonthsComplete,
      unconfirmedManualHolidayMonths: context.unconfirmedManualHolidayMonths,
    },
    staff: visible,
    summary: {
      staffCount: visible.length,
      confirmedCount: visible.filter((result) => result.status === "CONFIRMED").length,
      needsReviewCount: visible.filter((result) => result.status !== "CONFIRMED").length,
      grossPay: visible.reduce((sum, result) => sum + result.grossPay, 0),
    },
  };
}
