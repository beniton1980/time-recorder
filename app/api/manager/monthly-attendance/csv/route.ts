import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { enforceRateLimit } from "@/lib/api-security";
import { calculateClosingPeriod } from "@/lib/monthly-attendance.mjs";
import { loadMonthlyAttendance } from "@/lib/monthly-attendance-query";
import { buildMonthlyAttendanceReport } from "@/lib/monthly-attendance-report.mjs";
import { createMonthlyAttendanceCsv } from "@/lib/monthly-attendance-csv.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { idToken?: unknown; storeId?: unknown; periodEnd?: unknown };
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  let body: Body;
  try { body = await request.json() as Body; }
  catch { return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  if (typeof body.idToken !== "string" || typeof body.storeId !== "string" || !uuidPattern.test(body.storeId) || typeof body.periodEnd !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.periodEnd)) {
    return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }
  const limited = await enforceRateLimit(request, { scope: "manager-monthly-csv", limit: 30, windowSeconds: 300 }, body.idToken);
  if (limited) return limited;
  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({
      mode: "manager",
      lineIdentity: identity.sub,
      storeId: body.storeId as string,
    });
    const managers = await sql`
      SELECT s.id, s.name, s.timezone, s.closing_rule
      FROM staff st JOIN stores s ON s.id = st.store_id
      WHERE st.line_user_id = ${identity.sub}
        AND st.store_id = ${body.storeId}::uuid
        AND st.status = 'active'
        AND st.role = 'MANAGER'
        AND s.status = 'active'
      LIMIT 1
    `;
    if (managers.length === 0) return Response.json({ ok: false, code: "MANAGER_ACCESS_REQUIRED" }, { status: 403 });
    const store = managers[0];
    const period = calculateClosingPeriod(String(store.closing_rule), body.periodEnd);
    const reports = await sql`
      SELECT id FROM monthly_attendance_deliveries
      WHERE store_id = ${store.id}::uuid AND period_start = ${period.start}::date AND period_end = ${period.end}::date
        AND delivery_version = 'initial' AND status = 'SENT' LIMIT 1
    `;
    if (reports.length === 0) return Response.json({ ok: false, code: "MONTHLY_REPORT_NOT_FOUND" }, { status: 404 });
    const monthly = await loadMonthlyAttendance(sql as never, String(store.id), period);
    const report = buildMonthlyAttendanceReport({
      storeName: String(store.name),
      timezone: String(store.timezone),
      label: `${period.end.slice(5, 7)}月度`,
      period,
      generatedAt: new Date(),
      events: monthly.events as never,
      days: monthly.dailyAttendanceRecords,
    });
    const csv = createMonthlyAttendanceCsv(report);
    const label = `${period.end.slice(0, 7)}-${period.end.slice(8, 10)}締め`;
    const filename = encodeURIComponent(`${store.name}-${label}-勤怠.csv`);
    return new Response(csv, { headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="attendance-${period.end}.csv"; filename*=UTF-8''${filename}`,
      "Cache-Control": "no-store",
    }});
  } catch (error) {
    if (error instanceof LineTokenVerificationError) return Response.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    if (error instanceof RangeError) return Response.json({ ok: false, code: "INVALID_PERIOD_END" }, { status: 400 });
    logServerError("monthly_attendance_csv_failed");
    return Response.json({ ok: false, code: "CSV_EXPORT_UNAVAILABLE" }, { status: 503 });
  }
}

