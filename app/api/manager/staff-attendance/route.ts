import { getSql } from "@/lib/db";
import { enforceRateLimit } from "@/lib/api-security";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { loadMonthlyAttendance } from "@/lib/monthly-attendance-query";
import { buildMonthlyAttendanceReport } from "@/lib/monthly-attendance-report.mjs";
import { logServerError } from "@/lib/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { idToken?: unknown; storeId?: unknown; staffId?: unknown; month?: unknown };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function monthPeriod(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const endDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(endDay).padStart(2, "0")}` };
}

export async function POST(request: Request) {
  let body: Body;
  try { body = await request.json() as Body; }
  catch { return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }

  if (
    typeof body.idToken !== "string" ||
    typeof body.storeId !== "string" || !uuidPattern.test(body.storeId) ||
    typeof body.staffId !== "string" || !uuidPattern.test(body.staffId) ||
    typeof body.month !== "string" || !/^\d{4}-\d{2}$/.test(body.month)
  ) {
    return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  const limited = await enforceRateLimit(request, { scope: "manager-staff-attendance", limit: 60, windowSeconds: 300 }, body.idToken);
  if (limited) return limited;

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({ mode: "manager", lineIdentity: identity.sub, storeId: body.storeId });
    const managers = await sql`
      SELECT
        s.id,
        s.name,
        s.timezone,
        (((NOW() AT TIME ZONE s.timezone)
          - make_interval(mins => s.business_day_start_minute))::date)::text AS current_business_date
      FROM staff st
      JOIN stores s ON s.id = st.store_id
      LEFT JOIN staff_manager_access access
        ON access.staff_id = st.id AND access.store_id = st.store_id
      WHERE st.line_user_id = ${identity.sub}
        AND st.store_id = ${body.storeId}::uuid
        AND st.status = 'active'
        AND (st.role = 'MANAGER' OR access.status = 'active')
        AND s.status = 'active'
      LIMIT 1
    `;
    if (managers.length === 0) return Response.json({ ok: false, code: "MANAGER_ACCESS_REQUIRED" }, { status: 403 });

    const staffOptions = await sql`
      SELECT id, legal_name, status
      FROM staff
      WHERE store_id = ${body.storeId}::uuid
        AND role = 'STAFF'
        AND status <> 'departed'
      ORDER BY legal_name ASC, created_at ASC
    `;
    const target = staffOptions.find((staff) => String(staff.id) === body.staffId);
    if (!target) return Response.json({ ok: false, code: "STAFF_NOT_FOUND" }, { status: 404 });

    const store = managers[0];
    const period = monthPeriod(body.month);
    const currentBusinessDate = String(store.current_business_date);
    const displayThrough = currentBusinessDate < period.start
      ? null
      : currentBusinessDate > period.end
        ? period.end
        : currentBusinessDate;

    const monthly = await loadMonthlyAttendance(sql as never, String(store.id), period);
    const events = monthly.events.filter((event) => String(event.staff_id) === body.staffId);
    const days = monthly.dailyAttendanceRecords.filter((day) => String(day.staffId) === body.staffId);
    const report = buildMonthlyAttendanceReport({
      storeName: String(store.name),
      timezone: String(store.timezone),
      label: `${body.month.slice(5, 7)}月`,
      period,
      generatedAt: new Date(),
      events: events as never,
      days,
    });
    const staff = report.staff[0] ?? {
      name: String(target.legal_name),
      workDays: 0,
      workMinutes: 0,
      breakMinutes: 0,
      lateNightMinutes: 0,
      workDuration: "00:00",
      breakDuration: "00:00",
      lateNightDuration: "00:00",
      attendanceIssueDays: 0,
      gpsIssueCount: 0,
      attendanceReasons: [],
      dailyAttendance: [],
      events: [],
    };

    return Response.json({
      ok: true,
      store: { id: String(store.id), name: String(store.name) },
      staff: { id: body.staffId, legalName: String(target.legal_name) },
      staffOptions: staffOptions.map((item) => ({
        id: String(item.id),
        legalName: String(item.legal_name),
        status: String(item.status),
      })),
      month: body.month,
      period: { ...period, displayThrough },
      summary: {
        workDays: staff.workDays,
        workDuration: staff.workDuration,
        breakDuration: staff.breakDuration,
        issueDays: staff.attendanceIssueDays,
        gpsIssueCount: staff.gpsIssueCount,
      },
      days: staff.dailyAttendance,
      events: events.map((event) => ({
        effectiveId: String(event.effective_id),
        businessDate: String(event.business_date),
        eventType: String(event.event_type),
        occurredAt: String(event.occurred_at),
        corrected: Boolean(event.corrected),
      })),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) return Response.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    logServerError("manager_staff_attendance_failed");
    return Response.json({ ok: false, code: "STAFF_ATTENDANCE_UNAVAILABLE" }, { status: 503 });
  }
}
