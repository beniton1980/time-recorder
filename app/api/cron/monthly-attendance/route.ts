import { getSql } from "@/lib/db";
import { calculateClosingPeriod } from "@/lib/monthly-attendance.mjs";
import { loadMonthlyAttendance } from "@/lib/monthly-attendance-query";
import { buildMonthlyAttendanceReport } from "@/lib/monthly-attendance-report.mjs";
import { generateMonthlyAttendancePdf } from "@/lib/monthly-attendance-pdf.mjs";
import { sendMonthlyAttendanceEmail } from "@/lib/monthly-attendance-email.mjs";
import { monthlyAttendanceDeliveryErrorCode } from "@/lib/monthly-attendance-delivery-error.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ ok: false, code: "UNAUTHORIZED" }, { status: 401 });
  }
  const sql = getSql();
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
      COALESCE(
        s.monthly_report_email,
        (
          SELECT r.contact_email
          FROM onboarding_requests r
          WHERE r.provisioned_store_id = s.id
          ORDER BY r.created_at DESC
          LIMIT 1
        )
      ) AS contact_email,
      candidates.period_start, candidates.period_end
    FROM candidates
    JOIN stores s ON s.id = candidates.id
    ORDER BY s.id, candidates.period_end
  `;
  const results = [];
  for (const store of stores) {
    if (!store.contact_email) {
      results.push({ storeId: store.id, status: "SKIPPED", code: "MONTHLY_REPORT_EMAIL_NOT_CONFIGURED" });
      continue;
    }
    const period = store.period_start
      ? { start: String(store.period_start), end: String(store.period_end) }
      : calculateClosingPeriod(String(store.closing_rule), String(store.period_end));
    const claimed = await sql`
      INSERT INTO monthly_attendance_deliveries (store_id, period_start, period_end, recipient)
      VALUES (${store.id}::uuid, ${period.start}::date, ${period.end}::date, ${store.contact_email})
      ON CONFLICT (store_id, period_start, period_end, delivery_version)
      DO UPDATE SET status = 'PROCESSING', attempt_count = monthly_attendance_deliveries.attempt_count + 1, updated_at = NOW()
      WHERE monthly_attendance_deliveries.status = 'FAILED'
        OR (monthly_attendance_deliveries.status = 'PROCESSING' AND monthly_attendance_deliveries.updated_at < NOW() - INTERVAL '15 minutes')
      RETURNING id
    `;
    if (claimed.length === 0) { results.push({ storeId: store.id, status: "SKIPPED" }); continue; }
    try {
      const monthly = await loadMonthlyAttendance(sql as never, String(store.id), period);
      const report = buildMonthlyAttendanceReport({ storeName: String(store.name), timezone: String(store.timezone), label: `${period.end.slice(5, 7)}月度`, period, generatedAt: new Date(), events: monthly.events as never, days: monthly.days });
      const pdf = generateMonthlyAttendancePdf(report);
      const issueDays = report.staff.reduce((sum, member) => sum + member.attendanceIssueDays, 0);
      const gpsIssues = report.staff.reduce((sum, member) => sum + member.gpsIssueCount, 0);
      const email = await sendMonthlyAttendanceEmail({ storeId: String(store.id), storeName: String(store.name), recipient: String(store.contact_email), label: report.label, period, staffCount: report.staff.length, attendanceIssueDays: issueDays, gpsIssueCount: gpsIssues, deliveryVersion: "initial", pdf });
      if (!email.sent) throw new Error(email.code);
      await sql`UPDATE monthly_attendance_deliveries SET status = 'SENT', provider_email_id = ${email.emailId}, sent_at = NOW(), updated_at = NOW() WHERE id = ${claimed[0].id}::uuid`;
      results.push({ storeId: store.id, status: "SENT" });
    } catch (error) {
      const code = monthlyAttendanceDeliveryErrorCode(error);
      await sql`UPDATE monthly_attendance_deliveries SET status = 'FAILED', last_error_code = ${code}, updated_at = NOW() WHERE id = ${claimed[0].id}::uuid`;
      results.push({ storeId: store.id, status: "FAILED", code });
    }
  }
  return Response.json({ ok: true, processed: results.length, results });
}
