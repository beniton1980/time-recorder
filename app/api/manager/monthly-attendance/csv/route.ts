import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { enforceRateLimit } from "@/lib/api-security";
import { calculateClosingPeriod } from "@/lib/monthly-attendance.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { idToken?: unknown; storeId?: unknown; periodEnd?: unknown };
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const eventLabels: Record<string, string> = { CHECK_IN: "出勤", BREAK_START: "休憩開始", BREAK_END: "休憩終了", CHECK_OUT: "退勤" };
const locationLabels: Record<string, string> = {
  OUTSIDE_STORE_RADIUS: "店舗範囲外",
  LOW_GPS_ACCURACY: "GPS精度不足",
  CLIENT_LOCATION_UNAVAILABLE: "位置情報取得不可",
  STORE_LOCATION_UNAVAILABLE: "店舗位置未設定",
};

function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

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
    const sql = getSql();
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
    const rows = await sql`
      SELECT epe.business_date::text, st.legal_name, epe.event_type,
        to_char(epe.occurred_at AT TIME ZONE ${store.timezone}, 'YYYY-MM-DD HH24:MI:SS') AS occurred_at_local,
        epe.corrected, epe.validation_code
      FROM effective_punch_events epe JOIN staff st ON st.id = epe.staff_id
      WHERE epe.store_id = ${store.id}::uuid AND epe.business_date BETWEEN ${period.start}::date AND ${period.end}::date
      ORDER BY epe.business_date, st.legal_name, epe.occurred_at, epe.effective_id
    `;
    const lines = [
      ["営業日", "スタッフ名", "打刻種類", "打刻日時", "訂正", "位置情報"].map(csvCell).join(","),
      ...rows.map((row) => [row.business_date, row.legal_name, eventLabels[String(row.event_type)] ?? row.event_type, row.occurred_at_local, row.corrected ? "訂正あり" : "", locationLabels[String(row.validation_code)] ?? ""].map(csvCell).join(",")),
    ];
    const label = `${period.end.slice(0, 7)}-${period.end.slice(8, 10)}締め`;
    const filename = encodeURIComponent(`${store.name}-${label}-勤怠.csv`);
    return new Response(`\uFEFF${lines.join("\r\n")}\r\n`, { headers: {
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

