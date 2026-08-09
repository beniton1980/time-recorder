import { getSql } from "@/lib/db";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { calculateClosingPeriod } from "@/lib/monthly-attendance.mjs";
import { loadMonthlyAttendance } from "@/lib/monthly-attendance-query";
import { buildMonthlyAttendanceReport } from "@/lib/monthly-attendance-report.mjs";
import { generateMonthlyAttendancePdf } from "@/lib/monthly-attendance-pdf.mjs";
import { sendMonthlyAttendanceEmail } from "@/lib/monthly-attendance-email.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Body = { idToken?: unknown; periodEnd?: unknown; requestId?: unknown };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  let body: Body;
  try { body = await request.json() as Body; }
  catch { return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  if (typeof body.idToken !== "string" || typeof body.periodEnd !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.periodEnd) || typeof body.requestId !== "string" || !uuidPattern.test(body.requestId)) {
    return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql();
    const managers = await sql`
      SELECT s.id, s.name, s.timezone, s.closing_rule, r.contact_email
      FROM staff st JOIN stores s ON s.id = st.store_id
      JOIN onboarding_requests r ON r.provisioned_store_id = s.id
      WHERE st.line_user_id = ${identity.sub} AND st.status = 'active' AND st.role = 'MANAGER' AND s.status = 'active'
      ORDER BY st.created_at LIMIT 1
    `;
    if (managers.length === 0) return Response.json({ ok: false, code: "MANAGER_ACCESS_REQUIRED" }, { status: 403 });
    const store = managers[0];
    const period = calculateClosingPeriod(String(store.closing_rule), body.periodEnd);
    const initial = await sql`
      SELECT id FROM monthly_attendance_deliveries
      WHERE store_id = ${store.id}::uuid AND period_start = ${period.start}::date AND period_end = ${period.end}::date
        AND delivery_version = 'initial' AND status = 'SENT'
      LIMIT 1
    `;
    if (initial.length === 0) return Response.json({ ok: false, code: "MONTHLY_REPORT_NOT_FOUND" }, { status: 404 });
    const version = `reissue-${body.requestId}`;
    const claimed = await sql`
      INSERT INTO monthly_attendance_deliveries (store_id, period_start, period_end, delivery_version, recipient)
      VALUES (${store.id}::uuid, ${period.start}::date, ${period.end}::date, ${version}, ${store.contact_email})
      ON CONFLICT (store_id, period_start, period_end, delivery_version)
      DO UPDATE SET status = 'PROCESSING', attempt_count = monthly_attendance_deliveries.attempt_count + 1, updated_at = NOW()
      WHERE monthly_attendance_deliveries.status = 'FAILED'
      RETURNING id
    `;
    if (claimed.length === 0) return Response.json({ ok: true, status: "ALREADY_PROCESSED" });
    try {
      const monthly = await loadMonthlyAttendance(sql as never, String(store.id), period);
      const report = buildMonthlyAttendanceReport({ storeName: String(store.name), timezone: String(store.timezone), label: `${period.end.slice(5, 7)}月度`, period, generatedAt: new Date(), events: monthly.events as never, days: monthly.days });
      const pdf = generateMonthlyAttendancePdf(report);
      const email = await sendMonthlyAttendanceEmail({ storeId: String(store.id), storeName: String(store.name), recipient: String(store.contact_email), label: report.label, period, staffCount: report.staff.length, attendanceIssueDays: report.staff.reduce((sum, member) => sum + member.attendanceIssueDays, 0), gpsIssueCount: report.staff.reduce((sum, member) => sum + member.gpsIssueCount, 0), deliveryVersion: version, pdf });
      if (!email.sent) throw new Error(email.code);
      await sql`UPDATE monthly_attendance_deliveries SET status = 'SENT', provider_email_id = ${email.emailId}, sent_at = NOW(), updated_at = NOW() WHERE id = ${claimed[0].id}::uuid`;
      return Response.json({ ok: true, status: "SENT", period });
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 100) : "UNKNOWN_ERROR";
      await sql`UPDATE monthly_attendance_deliveries SET status = 'FAILED', last_error_code = ${code}, updated_at = NOW() WHERE id = ${claimed[0].id}::uuid`;
      return Response.json({ ok: false, code: "REISSUE_FAILED" }, { status: 503 });
    }
  } catch (error) {
    if (error instanceof LineTokenVerificationError) return Response.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    if (error instanceof RangeError) return Response.json({ ok: false, code: "INVALID_PERIOD_END" }, { status: 400 });
    console.error("Monthly attendance reissue failed", error);
    return Response.json({ ok: false, code: "REISSUE_UNAVAILABLE" }, { status: 503 });
  }
}

