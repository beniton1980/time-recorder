import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { calculateClosingPeriod } from "@/lib/monthly-attendance.mjs";
import { loadMonthlyAttendance } from "@/lib/monthly-attendance-query";
import { buildMonthlyAttendanceReport, monthlyAttendanceGpsIssues, monthlyAttendanceIssues, monthlyAttendanceStaffSummaries } from "@/lib/monthly-attendance-report.mjs";
import { generateMonthlyAttendancePdf } from "@/lib/monthly-attendance-pdf.mjs";
import { sendMonthlyAttendanceEmail } from "@/lib/monthly-attendance-email.mjs";
import { enforceRateLimit } from "@/lib/api-security";
import { isConfirmedMonthlyReportRecipient } from "@/lib/monthly-report-recipient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Body = { idToken?: unknown; storeId?: unknown; periodEnd?: unknown; requestId?: unknown };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function classifyFailure(value: unknown) {
  if (!(value instanceof Error)) return {};
  const code = "code" in value && typeof (value as Error & { code?: unknown }).code === "string"
    ? (value as Error & { code: string }).code
    : undefined;
  return {
    failureName: value.name.slice(0, 80),
    ...(code ? { failureCode: code.slice(0, 80) } : {}),
  };
}

export async function POST(request: Request) {
  let body: Body;
  try { body = await request.json() as Body; }
  catch { return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }

  if (
    typeof body.idToken !== "string"
    || typeof body.storeId !== "string"
    || !uuidPattern.test(body.storeId)
    || typeof body.periodEnd !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(body.periodEnd)
    || typeof body.requestId !== "string"
    || !uuidPattern.test(body.requestId)
  ) {
    return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  const limited = await enforceRateLimit(
    request,
    { scope: "manager-monthly-acceptance-test", limit: 3, windowSeconds: 600 },
    body.idToken,
  );
  if (limited) return limited;

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({ mode: "manager", lineIdentity: identity.sub, storeId: body.storeId });
    const managers = await sql`
      SELECT s.id, s.name, s.timezone, s.closing_rule,
        s.monthly_report_email,
        s.monthly_report_email_verified_at,
        s.monthly_report_email_consented_at,
        s.monthly_report_email_consent_version,
        s.monthly_report_recipient_version_id
      FROM staff st
      JOIN stores s ON s.id = st.store_id
      WHERE st.line_user_id = ${identity.sub}
        AND st.store_id = ${body.storeId}::uuid
        AND st.status = 'active'
        AND st.role = 'MANAGER'
        AND s.status = 'active'
      LIMIT 1
    `;
    if (managers.length === 0) {
      return Response.json({ ok: false, code: "MANAGER_ACCESS_REQUIRED" }, { status: 403 });
    }

    const store = managers[0];
    if (!isConfirmedMonthlyReportRecipient(store)) {
      return Response.json({ ok: false, code: "MONTHLY_REPORT_RECIPIENT_NOT_CONFIRMED" }, { status: 409 });
    }

    const period = calculateClosingPeriod(String(store.closing_rule), body.periodEnd);

    let monthly;
    try {
      monthly = await loadMonthlyAttendance(sql as never, String(store.id), period);
    } catch {
      logServerError("monthly_attendance_acceptance_aggregation_failed");
      return Response.json({ ok: false, code: "MONTHLY_AGGREGATION_FAILED" }, { status: 503 });
    }

    let report;
    try {
      report = buildMonthlyAttendanceReport({
        storeName: String(store.name),
        timezone: String(store.timezone),
        label: `${period.end.slice(5, 7)}月度`,
        period,
        generatedAt: new Date(),
        events: monthly.events as never,
        days: monthly.days,
      });
    } catch {
      logServerError("monthly_attendance_acceptance_report_failed");
      return Response.json({ ok: false, code: "MONTHLY_REPORT_BUILD_FAILED" }, { status: 503 });
    }

    let pdf: Uint8Array;
    try {
      pdf = await generateMonthlyAttendancePdf(report);
    } catch (failure) {
      const safeFields = classifyFailure(failure);
      logServerError("monthly_attendance_acceptance_pdf_failed", safeFields);
      return Response.json({ ok: false, code: "MONTHLY_PDF_FAILED" }, { status: 503 });
    }

    let attendanceIssueDays: number;
    let gpsIssueCount: number;
    let attendanceIssues;
    try {
      attendanceIssueDays = report.staff.reduce((sum, member) => sum + member.attendanceIssueDays, 0);
      gpsIssueCount = report.staff.reduce((sum, member) => sum + member.gpsIssueCount, 0);
      attendanceIssues = monthlyAttendanceIssues(report);
    } catch {
      logServerError("monthly_attendance_acceptance_summary_failed");
      return Response.json({ ok: false, code: "MONTHLY_REPORT_SUMMARY_FAILED" }, { status: 503 });
    }

    let email;
    try {
      email = await sendMonthlyAttendanceEmail({
        storeId: String(store.id),
        storeName: String(store.name),
        recipient: String(store.monthly_report_email),
        label: report.label,
        period,
        staffCount: report.staff.length,
        attendanceIssueDays,
        attendanceIssues,
        gpsIssueCount,
        gpsIssues: monthlyAttendanceGpsIssues(report),
        staffSummaries: monthlyAttendanceStaffSummaries(report),
        deliveryVersion: `acceptance-${body.requestId}`,
        acceptanceTest: true,
        pdf,
      });
    } catch {
      logServerError("monthly_attendance_acceptance_email_exception");
      return Response.json({ ok: false, code: "EMAIL_DELIVERY_FAILED" }, { status: 503 });
    }
    if (!email.sent) {
      return Response.json({ ok: false, code: email.code }, { status: 503 });
    }

    return Response.json({
      ok: true,
      status: "SENT",
      period,
      staffCount: report.staff.length,
      attendanceIssueDays,
      gpsIssueCount,
    });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return Response.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    if (error instanceof RangeError) {
      return Response.json({ ok: false, code: "INVALID_PERIOD_END" }, { status: 400 });
    }
    logServerError("monthly_attendance_acceptance_test_failed");
    return Response.json({ ok: false, code: "ACCEPTANCE_TEST_UNAVAILABLE" }, { status: 503 });
  }
}
