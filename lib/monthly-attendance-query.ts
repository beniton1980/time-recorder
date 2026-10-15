import { deriveDailyAttendanceRecords } from "@/lib/monthly-attendance.mjs";
import type {
  EffectivePunch,
  PendingCorrection,
} from "@/lib/monthly-attendance.mjs";

type Period = { start: string; end: string };
type SqlClient = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

type MonthlyReportReference = { reportId: string } | { periodEnd: string };

export function isMonthlyReportReference<T extends { reportId?: unknown; periodEnd?: unknown }>(value: T): value is T & MonthlyReportReference {
  if (value.reportId !== undefined) {
    return typeof value.reportId === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.reportId);
  }
  if (typeof value.periodEnd !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.periodEnd)) return false;
  const date = new Date(`${value.periodEnd}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.periodEnd;
}

export async function loadSentMonthlyReportPeriod(sql: SqlClient, storeId: string, reference: MonthlyReportReference): Promise<Period | null> {
  const reportId = "reportId" in reference ? reference.reportId : null;
  const periodEnd = "reportId" in reference ? null : reference.periodEnd;
  // Historical periods belong to the sent initial delivery, not today's closing rule.
  // Older open clients send only periodEnd; never pick arbitrarily if it is ambiguous.
  const reports = await sql`
    SELECT period_start::text AS start, period_end::text AS end
    FROM monthly_attendance_deliveries
    WHERE store_id = ${storeId}::uuid
      AND delivery_version = 'initial' AND status = 'SENT'
      AND (
        (${reportId}::uuid IS NOT NULL AND id = ${reportId}::uuid)
        OR (${reportId}::uuid IS NULL AND period_end::text = ${periodEnd})
      )
    LIMIT 2
  ` as Period[];
  return reports.length === 1 ? reports[0] : null;
}

export async function loadMonthlyAttendance(sql: SqlClient, storeId: string, period: Period) {
  const [events, pendingCorrections] = await Promise.all([
    sql`
      SELECT epe.*, epe.business_date::text AS business_date, st.legal_name
      FROM effective_punch_events epe
      JOIN staff st ON st.id = epe.staff_id
      WHERE epe.store_id = ${storeId}::uuid
        AND epe.business_date BETWEEN ${period.start}::date AND ${period.end}::date
      ORDER BY epe.staff_id, epe.business_date, epe.occurred_at, epe.effective_id
    `,
    sql`
      SELECT
        cr.store_id,
        cr.staff_id,
        st.legal_name,
        public.correction_request_business_date(cr.id)::text AS business_date
      FROM correction_requests cr
      JOIN staff st ON st.id = cr.staff_id
      WHERE cr.store_id = ${storeId}::uuid
        AND cr.status = 'PENDING'
        AND public.correction_request_business_date(cr.id) BETWEEN ${period.start}::date AND ${period.end}::date
    `,
  ]);
  const days = deriveDailyAttendanceRecords(
      events as EffectivePunch[],
      pendingCorrections as PendingCorrection[],
    );
  return { events: events as EffectivePunch[], days, dailyAttendanceRecords: days };
}
