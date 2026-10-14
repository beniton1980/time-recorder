import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { enforceRateLimit } from "@/lib/api-security";
import { loadMonthlyAttendance } from "@/lib/monthly-attendance-query";
import { buildMonthlyAttendanceReport, monthlyAttendanceGpsIssues, monthlyAttendanceIssues, monthlyAttendanceStaffSummaries } from "@/lib/monthly-attendance-report.mjs";
import { createMonthlyAttendanceCsv } from "@/lib/monthly-attendance-csv.mjs";
import { generateMonthlyAttendancePdf } from "@/lib/monthly-attendance-pdf.mjs";
import { sendMonthlyAttendanceEmail } from "@/lib/monthly-attendance-email.mjs";
import { monthlyAttendanceDeliveryErrorCode } from "@/lib/monthly-attendance-delivery-error.mjs";
import { isConfirmedMonthlyReportRecipient } from "@/lib/monthly-report-recipient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Body = { idToken?: unknown; storeId?: unknown; periodStart?: unknown; periodEnd?: unknown; action?: unknown };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export async function POST(request: Request) {
  let body: Body;
  try { body = await request.json() as Body; }
  catch { return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || typeof body.idToken !== "string" || typeof body.storeId !== "string" || !uuidPattern.test(body.storeId)
    || typeof body.action !== "string" || !["pdf", "csv", "send"].includes(body.action)) {
    return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }
  if (!validDate(body.periodStart) || !validDate(body.periodEnd)
    || body.periodStart > body.periodEnd
    || Date.parse(body.periodEnd) - Date.parse(body.periodStart) > 30 * 86400000) {
    return Response.json({ ok: false, code: "INVALID_PERIOD" }, { status: 400 });
  }
  const period = { start: body.periodStart, end: body.periodEnd };
  const limited = await enforceRateLimit(request, { scope: "manager-monthly-period", limit: 10, windowSeconds: 300 }, body.idToken);
  if (limited) return limited;
  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({ mode: "manager", lineIdentity: identity.sub, storeId: body.storeId });
    const managers = await sql`
      SELECT s.id, s.name, s.timezone,
        (NOW() AT TIME ZONE s.timezone)::date::text AS today,
        s.monthly_report_email, s.monthly_report_email_verified_at,
        s.monthly_report_email_consented_at, s.monthly_report_email_consent_version,
        s.monthly_report_recipient_version_id
      FROM staff st JOIN stores s ON s.id = st.store_id
      WHERE st.line_user_id = ${identity.sub} AND st.store_id = ${body.storeId}::uuid
        AND st.status = 'active' AND s.status = 'active'
        AND public.app_manager_store_allowed(st.store_id)
      LIMIT 1
    `;
    if (managers.length === 0) return Response.json({ ok: false, code: "MANAGER_ACCESS_REQUIRED" }, { status: 403 });
    const store = managers[0];
    // Complete past days only. The database clock, not the browser clock, is authoritative.
    if (period.end >= String(store.today)) return Response.json({ ok: false, code: "INVALID_PERIOD" }, { status: 400 });

    let attemptId: string | null = null;
    let recipient: string | null = null;
    if (body.action === "send") {
      if (!isConfirmedMonthlyReportRecipient(store)) return Response.json({ ok: false, code: "MONTHLY_REPORT_RECIPIENT_NOT_CONFIRMED" }, { status: 409 });
      // Use the same initial-period key as Cron: a retry or concurrent Cron cannot double-send.
      const claimed = await sql`
        SELECT * FROM claim_monthly_attendance_delivery(
          ${store.id}::uuid, ${period.start}::date, ${period.end}::date,
          'initial', ${store.monthly_report_recipient_version_id}::uuid
        )
      `;
      if (claimed.length === 0) {
        const existing = await sql`
          SELECT status FROM monthly_attendance_deliveries
          WHERE store_id = ${store.id}::uuid AND period_start = ${period.start}::date
            AND period_end = ${period.end}::date AND delivery_version = 'initial'
        `;
        if (existing[0]?.status === "SENT") return Response.json({ ok: true, status: "ALREADY_SENT", period });
        if (existing[0]?.status === "PROCESSING") return Response.json({ ok: true, status: "PROCESSING", period });
        return Response.json({ ok: false, code: "MONTHLY_REPORT_RECIPIENT_CHANGED" }, { status: 409 });
      }
      attemptId = String(claimed[0].attempt_id);
      recipient = String(claimed[0].recipient);
    }

    try {
      const monthly = await loadMonthlyAttendance(sql as never, String(store.id), period);
      const report = buildMonthlyAttendanceReport({ storeName: String(store.name), timezone: String(store.timezone), label: `${period.end.slice(5, 7)}月度`, period, generatedAt: new Date(), events: monthly.events as never, days: monthly.days });
      if (body.action !== "send") {
        const format = body.action === "csv" ? "csv" : "pdf";
        const content = format === "csv" ? createMonthlyAttendanceCsv(report) : new Uint8Array(await generateMonthlyAttendancePdf(report));
        const filename = encodeURIComponent(`${store.name}-${period.start}-${period.end}-勤怠.${format}`);
        return new Response(content, { headers: {
          "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/pdf",
          "Content-Disposition": `attachment; filename="attendance-${period.start}-${period.end}.${format}"; filename*=UTF-8''${filename}`,
          "Cache-Control": "private, no-store",
        } });
      }
      const pdf = await generateMonthlyAttendancePdf(report);
      const email = await sendMonthlyAttendanceEmail({ storeId: String(store.id), storeName: String(store.name), recipient: recipient!, label: report.label, period, staffCount: report.staff.length, attendanceIssueDays: report.staff.reduce((sum, member) => sum + member.attendanceIssueDays, 0), attendanceIssues: monthlyAttendanceIssues(report), gpsIssueCount: report.staff.reduce((sum, member) => sum + member.gpsIssueCount, 0), gpsIssues: monthlyAttendanceGpsIssues(report), staffSummaries: monthlyAttendanceStaffSummaries(report), deliveryVersion: `initial-${attemptId}`, pdf });
      if (!email.sent) throw new Error(email.code);
      await sql`SELECT finish_monthly_attendance_delivery_attempt(${attemptId}::uuid, TRUE, ${email.emailId}, NULL)`;
      return Response.json({ ok: true, status: "SENT", period });
    } catch (error) {
      if (attemptId) {
        await sql`SELECT finish_monthly_attendance_delivery_attempt(${attemptId}::uuid, FALSE, NULL, ${monthlyAttendanceDeliveryErrorCode(error)})`;
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof LineTokenVerificationError) return Response.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    logServerError("monthly_attendance_period_failed");
    return Response.json({ ok: false, code: "MONTHLY_REPORT_UNAVAILABLE" }, { status: 503 });
  }
}
