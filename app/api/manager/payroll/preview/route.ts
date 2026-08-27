import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { getSql } from "@/lib/db";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { logServerError } from "@/lib/safe-log";
import { loadMonthlyAttendance } from "@/lib/monthly-attendance-query";
import { buildPayrollPreviewContext, calculateStaffPayrollPreview } from "@/lib/payroll-preview.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

type RequestBody = { idToken?: unknown; storeId?: unknown; periodStart?: unknown; periodEnd?: unknown };

type SettingsRow = {
  work_time_system: string;
  week_starts_on: number;
  overtime_month_rule: string;
  statutory_holiday_rule: string;
  statutory_holiday_weekday: number | null;
  overtime_premium_rate: number;
  high_overtime_premium_rate: number;
  statutory_holiday_premium_rate: number;
  late_night_premium_rate: number;
};

type StaffRow = { staff_id: string; legal_name: string; status: string };
type TermRow = { id: string; staff_id: string; hourly_rate_yen: number; effective_from: string; effective_to: string | null };

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !isoDatePattern.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export async function POST(request: Request) {
  let body: RequestBody;
  try { body = (await request.json()) as RequestBody; }
  catch { return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }

  if (typeof body.idToken !== "string" || typeof body.storeId !== "string" || !uuidPattern.test(body.storeId)
      || !validDate(body.periodStart) || !validDate(body.periodEnd) || body.periodStart > body.periodEnd) {
    return NextResponse.json({ ok: false, code: "INVALID_INPUT" }, { status: 400 });
  }

  const limited = await enforceRateLimit(request, { scope: "manager-payroll-preview", limit: 30, windowSeconds: 300 }, body.idToken);
  if (limited) return limited;

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({ mode: "manager", lineIdentity: identity.sub, storeId: body.storeId });
    const [settingsRows, staffRows, termRows, manualHolidayRows] = await Promise.all([
      sql`
        SELECT work_time_system, week_starts_on, overtime_month_rule,
          statutory_holiday_rule, statutory_holiday_weekday,
          overtime_premium_rate::float8 AS overtime_premium_rate,
          high_overtime_premium_rate::float8 AS high_overtime_premium_rate,
          statutory_holiday_premium_rate::float8 AS statutory_holiday_premium_rate,
          late_night_premium_rate::float8 AS late_night_premium_rate
        FROM payroll_store_settings
        WHERE store_id = ${body.storeId}::uuid
      `,
      sql`
        SELECT id AS staff_id, legal_name, status
        FROM staff
        WHERE store_id = ${body.storeId}::uuid
          AND status IN ('active', 'inactive')
        ORDER BY status ASC, created_at ASC
      `,
      sql`
        SELECT id, staff_id, hourly_rate_yen, effective_from::text, effective_to::text
        FROM payroll_compensation_terms
        WHERE store_id = ${body.storeId}::uuid
        ORDER BY staff_id, effective_from ASC
      `,
      sql`
        SELECT holiday_date::text AS holiday_date
        FROM payroll_statutory_holidays
        WHERE store_id = ${body.storeId}::uuid
          AND holiday_date BETWEEN ${body.periodStart}::date - INTERVAL '40 days' AND ${body.periodEnd}::date
        ORDER BY holiday_date
      `,
    ]);

    const row = (settingsRows[0] ?? null) as SettingsRow | null;
    const settings = {
      workTimeSystem: row?.work_time_system ?? "OTHER_REVIEW_REQUIRED",
      weekStartsOn: row?.week_starts_on ?? 1,
      overtimeMonthRule: row?.overtime_month_rule ?? "OTHER_REVIEW_REQUIRED",
      statutoryHolidayRule: row?.statutory_holiday_rule ?? "OTHER_REVIEW_REQUIRED",
      statutoryHolidayWeekday: row?.statutory_holiday_weekday ?? null,
      overtimePremiumRate: row?.overtime_premium_rate ?? 0.25,
      highOvertimePremiumRate: row?.high_overtime_premium_rate ?? 0.50,
      statutoryHolidayPremiumRate: row?.statutory_holiday_premium_rate ?? 0.35,
      lateNightPremiumRate: row?.late_night_premium_rate ?? 0.25,
    };
    const context = buildPayrollPreviewContext({
      payPeriodStart: body.periodStart,
      payPeriodEnd: body.periodEnd,
      settings,
      manualHolidayDates: manualHolidayRows.map((value) => String(value.holiday_date)),
    });
    const monthly = await loadMonthlyAttendance(sql as never, body.storeId, context.queryPeriod);
    const staff = staffRows as StaffRow[];
    const terms = termRows as TermRow[];

    const results = staff.map((member) => {
      const memberDays = monthly.days.filter((day) => day.staffId === member.staff_id);
      const memberTerms = terms.filter((term) => term.staff_id === member.staff_id).map((term) => ({
        id: term.id,
        hourlyRate: Number(term.hourly_rate_yen),
        effectiveFrom: term.effective_from,
        effectiveTo: term.effective_to,
      }));
      const preview = calculateStaffPayrollPreview({ attendanceDays: memberDays, compensationTerms: memberTerms, settings, context });
      const payableDayCount = memberDays.filter((day) => context.payPeriod.start <= day.businessDate && day.businessDate <= context.payPeriod.end && day.workedMinutes != null).length;
      return {
        staffId: member.staff_id,
        legalName: member.legal_name,
        staffStatus: member.status,
        payableDayCount,
        ...preview,
      };
    });

    const visible = results.filter((result) => result.payableDayCount > 0 || result.staffStatus === "active");
    return NextResponse.json({
      ok: true,
      mode: "PREVIEW_ONLY",
      persisted: false,
      period: context.payPeriod,
      context: {
        queryPeriod: context.queryPeriod,
        overtimeMonth: context.overtimeMonth,
        payPeriodInsideOvertimeMonth: context.payPeriodInsideOvertimeMonth,
      },
      staff: visible,
      summary: {
        staffCount: visible.length,
        confirmedCount: visible.filter((result) => result.status === "CONFIRMED").length,
        needsReviewCount: visible.filter((result) => result.status !== "CONFIRMED").length,
        grossPay: visible.reduce((sum, result) => sum + result.grossPay, 0),
      },
    });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    logServerError("manager_payroll_preview_failed");
    return NextResponse.json({ ok: false, code: "PAYROLL_PREVIEW_UNAVAILABLE" }, { status: 503 });
  }
}
