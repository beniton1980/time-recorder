import { getSql } from "@/lib/db";
import { enforceRateLimit } from "@/lib/api-security";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { loadMonthlyAttendance } from "@/lib/monthly-attendance-query";
import { logServerError } from "@/lib/safe-log";
import type { Consultation } from "@/lib/consultation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });

export async function POST(request: Request) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, code: "INVALID_JSON" }, 400); }
  if (!body || typeof body.idToken !== "string" || !body.idToken || typeof body.storeId !== "string" || !uuid.test(body.storeId)
    || !["detail", "list", "resolve"].includes(body.action)
    || (body.action !== "list" && (typeof body.requestId !== "string" || !uuid.test(body.requestId)))) return json({ ok: false, code: "INVALID_REQUEST" }, 400);
  const cursor = body.before;
  if (cursor != null && (typeof cursor.id !== "string" || !uuid.test(cursor.id) || typeof cursor.at !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.at) || !Number.isFinite(Date.parse(cursor.at)))) return json({ ok: false, code: "INVALID_CURSOR" }, 400);
  if (body.action === "resolve" && (typeof body.expectedVersion !== "string" || !/^\d{1,12}(?:\.\d{1,6})?$/.test(body.expectedVersion)
    || (body.reason != null && (typeof body.reason !== "string" || body.reason.trim().length > 500)))) return json({ ok: false, code: "INVALID_REQUEST" }, 400);
  const limited = await enforceRateLimit(request, { scope: "manager-consultations", limit: 60, windowSeconds: 300 }, body.idToken);
  if (limited) return limited;
  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({ mode: "manager", lineIdentity: identity.sub, storeId: body.storeId });
    const access = await sql`SELECT public.app_manager_store_allowed(${body.storeId}::uuid) AS allowed`;
    if (!access[0]?.allowed) return json({ ok: false, code: "MANAGER_ACCESS_REQUIRED" }, 403);
    if (body.action === "resolve") {
      const rows = await sql`SELECT * FROM public.resolve_consultation(${body.storeId}::uuid, ${body.requestId}::uuid,
        ${body.expectedVersion}, ${body.reason?.trim() || null})`;
      return json({ ok: true, resolution: rows[0] });
    }
    if (body.action === "list") {
      const rows = await sql`
        SELECT cr.id, st.legal_name AS "staffName", cr.reason, r.outcome,
          to_char(r.resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
        FROM consultation_resolutions r JOIN correction_requests cr ON cr.id = r.request_id JOIN staff st ON st.id = cr.staff_id
        WHERE r.store_id = ${body.storeId}::uuid
          AND (${cursor?.id ?? null}::uuid IS NULL OR (r.resolved_at, r.request_id) < (${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
        ORDER BY r.resolved_at DESC, r.request_id DESC LIMIT 21
      `;
      const items = rows.slice(0, 20), last = items.at(-1);
      return json({ ok: true, items, next: rows.length > 20 && last ? { id: last.id, at: last.at } : null });
    }
    const rows = await sql`
      SELECT cr.id, cr.staff_id AS "staffId", cr.store_id AS "storeId", st.legal_name AS "staffName", s.name AS "storeName",
        cr.reason, cr.requested_at AS "requestedAt", public.correction_request_status(cr.id) AS status,
        public.correction_request_business_date(cr.id)::text AS "requestDay",
        extract(epoch FROM ss.updated_at)::text AS version,
        target.business_date::text AS "targetDay", target.effective_id AS "targetId",
        r.resolved_at AS "resolvedAt", r.outcome, r.reason AS "resolutionReason",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.correction_id, 'operation', correction.operation,
          'before', c.before_event, 'after', c.after_event, 'reason', correction.reason, 'at', c.created_at)
          ORDER BY c.created_at, c.correction_id)
          FROM consultation_corrections c JOIN correction_requests correction ON correction.id = c.correction_id
          WHERE c.request_id = cr.id), '[]'::jsonb) AS changes
      FROM correction_requests cr JOIN staff st ON st.id = cr.staff_id JOIN stores s ON s.id = cr.store_id
      JOIN staff_states ss ON ss.staff_id = cr.staff_id
      LEFT JOIN consultation_resolutions r ON r.request_id = cr.id
      LEFT JOIN effective_punch_events target ON target.effective_id = COALESCE(cr.target_event_id, cr.target_correction_id)
        AND target.store_id = cr.store_id AND target.staff_id = cr.staff_id
      WHERE cr.id = ${body.requestId}::uuid AND cr.store_id = ${body.storeId}::uuid AND cr.operation = 'REVIEW'
    `;
    if (!rows[0]) return json({ ok: false, code: "CONSULTATION_NOT_FOUND" }, 404);
    const consultation = rows[0] as unknown as Consultation;
    const dates = [...new Set([consultation.requestDay, consultation.targetDay,
      ...consultation.changes.flatMap(c => [c.before?.day, c.after?.day])].filter((d): d is string => Boolean(d)))].sort();
    const monthly = await loadMonthlyAttendance(sql, body.storeId, { start: dates[0], end: dates.at(-1)! });
    const days = dates.map(businessDate => {
      const day = monthly.days.find(d => d.staffId === consultation.staffId && d.businessDate === businessDate);
      return { businessDate, status: day?.status ?? null, reasons: day?.attendanceReasons ?? [] };
    });
    return json({ ok: true, consultation, days });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) return json({ ok: false, code: "INVALID_ID_TOKEN" }, 401);
    const message = error instanceof Error ? error.message : "";
    for (const code of ["ATTENDANCE_CHANGED", "REQUEST_NOT_PENDING", "RESOLUTION_REASON_REQUIRED", "CONSULTATION_NOT_FOUND", "MANAGER_ACCESS_REQUIRED"]) {
      if (message.includes(code)) return json({ ok: false, code }, code === "CONSULTATION_NOT_FOUND" ? 404 : code === "MANAGER_ACCESS_REQUIRED" ? 403 : 409);
    }
    logServerError("manager_consultation_failed");
    return json({ ok: false, code: "CONSULTATION_UNAVAILABLE" }, 503);
  }
}
