import { getSql } from "@/lib/db";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let idToken: unknown;
  try { ({ idToken } = await request.json()); }
  catch { return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  if (typeof idToken !== "string") return Response.json({ ok: false, code: "ID_TOKEN_REQUIRED" }, { status: 400 });
  try {
    const identity = await verifyLineIdToken(idToken);
    const sql = getSql();
    const reports = await sql`
      SELECT d.period_start::text, d.period_end::text, d.sent_at,
        COUNT(*) FILTER (WHERE all_versions.delivery_version LIKE 'reissue-%' AND all_versions.status = 'SENT')::int AS reissue_count
      FROM staff st
      JOIN stores s ON s.id = st.store_id
      JOIN monthly_attendance_deliveries d ON d.store_id = s.id AND d.delivery_version = 'initial' AND d.status = 'SENT'
      LEFT JOIN monthly_attendance_deliveries all_versions ON all_versions.store_id = d.store_id AND all_versions.period_start = d.period_start AND all_versions.period_end = d.period_end
      WHERE st.line_user_id = ${identity.sub} AND st.status = 'active' AND st.role = 'MANAGER' AND s.status = 'active'
      GROUP BY d.id ORDER BY d.period_end DESC LIMIT 12
    `;
    return Response.json({ ok: true, reports });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) return Response.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    console.error("Monthly report listing failed", error);
    return Response.json({ ok: false, code: "REPORT_LIST_UNAVAILABLE" }, { status: 503 });
  }
}

