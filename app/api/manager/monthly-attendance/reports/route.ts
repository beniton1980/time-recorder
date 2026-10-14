import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { enforceRateLimit } from "@/lib/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { idToken?: unknown; storeId?: unknown; reportMonth?: unknown };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  let body: Body;
  try { body = await request.json() as Body; }
  catch { return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || typeof body.idToken !== "string" || typeof body.storeId !== "string" || !uuidPattern.test(body.storeId)) {
    return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }
  if (body.reportMonth !== undefined && (typeof body.reportMonth !== "string" || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(body.reportMonth))) {
    return Response.json({ ok: false, code: "INVALID_MONTH" }, { status: 400 });
  }
  const limited = await enforceRateLimit(request, { scope: "manager-monthly-reports", limit: 60, windowSeconds: 300 }, body.idToken);
  if (limited) return limited;
  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({
      mode: "manager",
      lineIdentity: identity.sub,
      storeId: body.storeId as string,
    });
    const managers = await sql`
      SELECT st.id, s.closing_rule, (NOW() AT TIME ZONE s.timezone)::date::text AS today
      FROM staff st
      JOIN stores s ON s.id = st.store_id
      WHERE st.line_user_id = ${identity.sub}
        AND st.store_id = ${body.storeId}::uuid
        AND st.status = 'active'
        AND public.app_manager_store_allowed(st.store_id)
        AND s.status = 'active'
      LIMIT 1
    `;
    if (managers.length === 0) {
      return Response.json({ ok: false, code: "MANAGER_ACCESS_REQUIRED" }, { status: 403 });
    }
    if (typeof body.reportMonth === "string") {
      // Month lookup must include history beyond the dashboard's latest 12 reports.
      // Keep every saved period in the month: changed closing days can yield multiple.
      const monthStart = `${body.reportMonth}-01`;
      const reports = await sql`
        SELECT id, period_start::text, period_end::text
        FROM monthly_attendance_deliveries
        WHERE store_id = ${body.storeId}::uuid
          AND delivery_version = 'initial' AND status = 'SENT'
          AND period_end >= ${monthStart}::date
          AND period_end < (${monthStart}::date + INTERVAL '1 month')
        ORDER BY period_end, period_start, id
      `;
      return Response.json({ ok: true, reportMonth: body.reportMonth, closingRule: managers[0].closing_rule, today: managers[0].today, reports }, { headers: { "Cache-Control": "private, no-store" } });
    }
    const reports = await sql`
      SELECT d.id, d.period_start::text, d.period_end::text, d.sent_at,
        COUNT(*) FILTER (WHERE all_versions.delivery_version LIKE 'reissue-%' AND all_versions.status = 'SENT')::int AS reissue_count
      FROM monthly_attendance_deliveries d
      LEFT JOIN monthly_attendance_deliveries all_versions ON all_versions.store_id = d.store_id AND all_versions.period_start = d.period_start AND all_versions.period_end = d.period_end
      WHERE d.store_id = ${body.storeId}::uuid
        AND d.delivery_version = 'initial' AND d.status = 'SENT'
      GROUP BY d.id ORDER BY d.period_end DESC LIMIT 12
    `;
    return Response.json({ ok: true, reports });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) return Response.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    logServerError("monthly_report_listing_failed");
    return Response.json({ ok: false, code: "REPORT_LIST_UNAVAILABLE" }, { status: 503 });
  }
}

