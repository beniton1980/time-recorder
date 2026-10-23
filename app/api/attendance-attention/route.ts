import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { LineTokenVerificationError, verifyLineIdToken } from "@/lib/line/verify-id-token";
import { hashStoreEntryToken } from "@/lib/store-entry-token";
import { enforceRateLimit } from "@/lib/api-security";
import { logServerError } from "@/lib/safe-log";
import { buildAttendanceAttention, type AttentionSource, type AttentionRequest } from "@/lib/attendance-attention";
import type { EffectivePunch } from "@/lib/monthly-attendance.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store, private" } });
export async function POST(request: Request) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, code: "INVALID_JSON" }, 400); }
  const hash = hashStoreEntryToken(body?.storeToken);
  if (body?.sourceEventId != null && (typeof body.sourceEventId !== "string" || !/^[a-f0-9-]{36}$/i.test(body.sourceEventId)))
    return json({ ok: false, code: "INVALID_REQUEST" }, 400);
  if (!hash || typeof body?.idToken !== "string" || !body.idToken || (body.after != null && (typeof body.after !== "string" || body.after.length > 160)))
    return json({ ok: false, code: "INVALID_REQUEST" }, 400);
  const limited = await enforceRateLimit(request, { scope: "attendance-attention", limit: 60, windowSeconds: 300 }, body.idToken);
  if (limited) return limited;
  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({ mode: "staff", lineIdentity: identity.sub, storeTokenHash: hash });
    const rows = await sql`
      SELECT NOW() AS "checkedAt",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('source', d.source, 'events', d.events))
          FROM public.staff_attention_days(s.id, st.id) d), '[]'::jsonb) AS days,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', cr.id, 'status', public.correction_request_status(cr.id),
          'operation', cr.operation, 'eventType', cr.requested_event_type, 'occurredAt', cr.requested_occurred_at,
          'requestedAt', cr.requested_at,
          'hasSavedCorrections', EXISTS (SELECT 1 FROM consultation_corrections c WHERE c.request_id = cr.id),
          'sourceEventId', link.source_reference->>'eventId',
          'sourceSnapshot', link.snapshot,
          'breakStartedAt', COALESCE(link.snapshot->>'breakStartedAt', CASE WHEN cr.requested_event_type = 'BREAK_END' THEN (
            SELECT e.occurred_at::text FROM effective_punch_events e WHERE e.staff_id = st.id AND e.store_id = s.id
              AND e.event_type = 'BREAK_START' AND e.occurred_at < cr.requested_occurred_at ORDER BY e.occurred_at DESC, e.effective_id DESC LIMIT 1) END),
          'matchedEventId', CASE WHEN cr.operation = 'ADD' AND cr.requested_event_type IN ('BREAK_END', 'CHECK_OUT') THEN (
            SELECT e.effective_id FROM effective_punch_events e WHERE e.staff_id = st.id AND e.store_id = s.id
              AND e.event_type = 'CHECK_IN' AND e.occurred_at < cr.requested_occurred_at ORDER BY e.occurred_at DESC, e.effective_id DESC LIMIT 1) END)
          ORDER BY cr.requested_at DESC, cr.id DESC)
          FROM correction_requests cr LEFT JOIN correction_attention_sources link ON link.request_id = cr.id
          WHERE cr.staff_id = st.id AND cr.store_id = s.id AND (cr.group_id IS NULL OR cr.group_id = cr.id)
            AND (public.correction_request_status(cr.id) = 'PENDING' OR cr.status = 'REJECTED')), '[]'::jsonb) AS requests
      FROM staff st JOIN stores s ON s.id = st.store_id JOIN store_entry_tokens token ON token.store_id = s.id
      WHERE st.line_user_id = ${identity.sub} AND st.status = 'active' AND s.status = 'active'
        AND token.token_hash = ${hash} AND token.active AND token.revoked_at IS NULL
        AND (token.expires_at IS NULL OR token.expires_at > NOW()) LIMIT 1
    `;
    if (!rows[0]) return json({ ok: false, code: "STAFF_OR_STORE_NOT_FOUND" }, 404);
    const all = buildAttendanceAttention(rows[0].days as { source: AttentionSource; events: EffectivePunch[] }[], rows[0].requests as AttentionRequest[]);
    const items = body.sourceEventId ? all.filter(item => item.source?.eventId === body.sourceEventId) : all;
    const offset = body.after == null ? 0 : items.findIndex(item => item.id === body.after) + 1;
    if (body.after != null && !offset) return json({ ok: false, code: "ATTENTION_CHANGED" }, 409);
    const page = items.slice(offset, offset + 20);
    return json({ ok: true, checkedAt: rows[0].checkedAt, items: page, next: items.length > offset + 20 ? page.at(-1)!.id : null });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) return json({ ok: false, code: "INVALID_ID_TOKEN" }, 401);
    logServerError("attendance_attention_failed");
    return json({ ok: false, code: "ATTENTION_UNAVAILABLE" }, 503);
  }
}
