import { assessAttendance } from "@/lib/monthly-attendance.mjs";
import type {
  EffectivePunch,
  PendingCorrection,
} from "@/lib/monthly-attendance.mjs";

type Period = { start: string; end: string };
type SqlClient = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

export async function loadMonthlyAttendance(sql: SqlClient, storeId: string, period: Period) {
  const [events, pendingCorrections] = await Promise.all([
    sql`
      SELECT epe.*, st.legal_name
      FROM effective_punch_events epe
      JOIN staff st ON st.id = epe.staff_id
      WHERE epe.store_id = ${storeId}::uuid
        AND epe.business_date BETWEEN ${period.start}::date AND ${period.end}::date
      ORDER BY epe.staff_id, epe.business_date, epe.occurred_at, epe.effective_id
    `,
    sql`
      SELECT
        cr.staff_id,
        st.legal_name,
        COALESCE(
          target.business_date,
          ((cr.requested_occurred_at AT TIME ZONE s.timezone)
            - make_interval(mins => s.business_day_start_minute))::date,
          ((cr.requested_at AT TIME ZONE s.timezone)
            - make_interval(mins => s.business_day_start_minute))::date
        )::text AS business_date
      FROM correction_requests cr
      JOIN stores s ON s.id = cr.store_id
      JOIN staff st ON st.id = cr.staff_id
      LEFT JOIN effective_punch_events target
        ON target.original_event_id = cr.target_event_id
      WHERE cr.store_id = ${storeId}::uuid
        AND cr.status = 'PENDING'
        AND COALESCE(
          target.business_date,
          ((cr.requested_occurred_at AT TIME ZONE s.timezone)
            - make_interval(mins => s.business_day_start_minute))::date,
          ((cr.requested_at AT TIME ZONE s.timezone)
            - make_interval(mins => s.business_day_start_minute))::date
        ) BETWEEN ${period.start}::date AND ${period.end}::date
    `,
  ]);
  return {
    events: events as EffectivePunch[],
    days: assessAttendance(
      events as EffectivePunch[],
      pendingCorrections as PendingCorrection[],
    ),
  };
}
