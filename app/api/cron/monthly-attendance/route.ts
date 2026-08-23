import { getSql } from "@/lib/db";
import { calculateClosingPeriod } from "@/lib/monthly-attendance.mjs";
import { loadMonthlyAttendance } from "@/lib/monthly-attendance-query";
import { buildMonthlyAttendanceReport, monthlyAttendanceGpsIssues, monthlyAttendanceIssues, monthlyAttendanceStaffSummaries } from "@/lib/monthly-attendance-report.mjs";
import { generateMonthlyAttendancePdf } from "@/lib/monthly-attendance-pdf.mjs";
import { sendMonthlyAttendanceEmail } from "@/lib/monthly-attendance-email.mjs";
import { monthlyAttendanceDeliveryErrorCode } from "@/lib/monthly-attendance-delivery-error.mjs";
import { isConfirmedMonthlyReportRecipient } from "@/lib/monthly-report-recipient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ ok: false, code: "UNAUTHORIZED" }, { status: 401 });
  }
  const sql = getSql({ mode: "cron" });
  const stores = await sql`
    WITH candidates AS (
      SELECT s.id,
        NULL::text AS period_start,
        ((NOW() AT TIME ZONE s.timezone) - INTERVAL '1 day')::date::text AS period_end
      FROM stores s
      WHERE s.status = 'active'
        AND (
          (s.closing_rule = 'month_end' AND EXTRACT(DAY FROM ((NOW() AT TIME ZONE s.timezone) - INTERVAL '1 day')) = EXTRACT(DAY FROM (date_trunc('month', (NOW() AT TIME ZONE s.timezone) - INTERVAL '1 day') + INTERVAL '1 month - 1 day')))
          OR s.closing_rule = 'day_' || EXTRACT(DAY FROM ((NOW() AT TIME ZONE s.timezone) - INTERVAL '1 day'))::int::text
        )
      UNION ALL
      SELECT s.id, d.period_start::text, d.period_end::text
      FROM monthly_attendance_deliveries d
      JOIN stores s ON s.id = d.store_id
      WHERE s.status = 'active'
        AND d.delivery_version = 'initial'
        AND (
          d.status = 'FAILED'
          OR (d.status = 'PROCESSING' AND d.updated_at < NOW() - INTERVAL '15 minutes')
        )
    )
    SELECT s.id, s.name, s.timezone, s.closing_rule,
      s.monthly_report_email,
      s.monthly_report_email_verified_at,
      s.monthly_report_email_consented_at,
      s.monthly_report_email_consent_version,
      s.monthly_report_recipient_version_id,
      candidates.period_start, candidates.period_end
    FROM candidates
    JOIN stores s ON s.id = candidates.id
    ORDER BY s.id, candidates.period_end
  `;
  const results = [];
  for (const store of stores) {
    if (!isConfirmedMonthlyReportRecipient(store)) {
      results.push({ storeId: store.id, status: "SKIPPED", code: "MONTHLY_REPORT_RECIPIENT_NOT_CONFIRMED" });
      continue;
    }
    const period = store.period_start
      ? { start: String(store.period_start), end: String(store.period_end) }
      : calculateClosingPeriod(String(store.closing_rule), String(store.period_end));
    const claimed = await sql`
      SELECT * FROM claim_monthly_attendance_delivery(
        ${store.id}::uuid,
        ${period.start}::date,
        ${period.end}::date,
        'initial',
        ${store.monthly_report_recipient_version_id}::uuid
      )
    `;
    if (claimed.length === 0) { results.push({ storeId: store.id, status: "SKIPPED" }); continue; }
    try {
      const monthly = await loadMonthlyAttendance(sql as never, String(store.id), period);
      const report = buildMonthlyAttendanceReport({ storeName: String(store.name), timezone: String(store.timezone), label: `${period.end.slice(5, 7)}月度`, period, generatedAt: new Date(), events: monthly.events as never, days: monthly.days });
      const pdf = await generateMonthlyAttendancePdf(report);
      const issueDays = report.staff.reduce((sum, member) => sum + member.attendanceIssueDays, 0);
      const gpsIssues = report.staff.reduce((sum, member) => sum + member.gpsIssueCount, 0);
      const email = await sendMonthlyAttendanceEmail({ storeId: String(store.id), storeName: String(store.name), recipient: String(claimed[0].recipient), label: report.label, period, staffCount: report.staff.length, attendanceIssueDays: issueDays, attendanceIssues: monthlyAttendanceIssues(report), gpsIssueCount: gpsIssues, gpsIssues: monthlyAttendanceGpsIssues(report), staffSummaries: monthlyAttendanceStaffSummaries(report), deliveryVersion: `initial-${claimed[0].attempt_id}`, pdf });
      if (!email.sent) throw new Error(email.code);
      await sql`SELECT finish_monthly_attendance_delivery_attempt(${claimed[0].attempt_id}::uuid, TRUE, ${email.emailId}, NULL)`;
      results.push({ storeId: store.id, status: "SENT" });
    } catch (error) {
      const code = monthlyAttendanceDeliveryErrorCode(error);
      await sql`SELECT finish_monthly_attendance_delivery_attempt(${claimed[0].attempt_id}::uuid, FALSE, NULL, ${code})`;
      results.push({ storeId: store.id, status: "FAILED", code });
    }
  }
  return Response.json({ ok: true, processed: results.length, results });
}
