import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";
import { LineTokenVerificationError, verifyLineIdToken } from "@/lib/line/verify-id-token";
import { hashStoreEntryToken } from "@/lib/store-entry-token";
import { enforceRateLimit } from "@/lib/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  const tokenHash = hashStoreEntryToken(body?.storeToken);
  if (!body || typeof body.idToken !== "string" || !body.idToken || !tokenHash) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }
  const cursor = body.before;
  const requestId = body.requestId;
  if (requestId != null && (typeof requestId !== "string" || !uuid.test(requestId))) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }
  if (cursor != null && (typeof cursor !== "object" || typeof cursor.id !== "string" || !uuid.test(cursor.id)
    || typeof cursor.requestedAt !== "string" || cursor.requestedAt.length > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.requestedAt)
    || !Number.isFinite(Date.parse(cursor.requestedAt)))) {
    return NextResponse.json({ ok: false, code: "INVALID_CURSOR" }, { status: 400 });
  }
  const limited = await enforceRateLimit(request, { scope: "correction-history", limit: 60, windowSeconds: 300 }, body.idToken);
  if (limited) return limited;
  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({ mode: "staff", lineIdentity: identity.sub, storeTokenHash: tokenHash });
    // Membership and history share one statement: eligibility cannot go stale
    // between two queries. Never accept a staff/store scope from the client.
    const memberships = await sql`
      SELECT st.id, COALESCE((
        SELECT jsonb_agg(item ORDER BY requested_at DESC, id DESC) FROM (
          SELECT cr.id, cr.requested_at, jsonb_build_object(
            'id', cr.id,
            'source', (SELECT link.snapshot FROM correction_attention_sources link WHERE link.request_id = cr.id),
            'requestedAt', to_char(cr.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'status', public.correction_request_status(cr.id),
            'hasSavedCorrections', EXISTS (SELECT 1 FROM consultation_corrections c WHERE c.request_id = cr.id),
            'outcome', resolution.outcome,
            'operation', cr.operation,
            'eventType', cr.requested_event_type,
            'occurredAt', cr.requested_occurred_at,
            'breakEndedAt', ending.requested_occurred_at,
            'decidedAt', COALESCE(resolution.resolved_at, cr.approved_at, cr.rejected_at),
            'automatic', cr.approved_by = 'SELF_SERVICE_RULE',
            'category', cr.client_request_payload->>'category',
            'reason', CASE WHEN cr.client_request_payload->>'category' = 'OTHER'
              THEN cr.client_request_payload->>'reason'
              WHEN cr.operation = 'REVIEW' THEN cr.reason ELSE NULL END,
            'unattributed', cr.client_request_id IS NULL AND cr.status = 'APPROVED'
              AND cr.approved_by IS DISTINCT FROM 'SELF_SERVICE_RULE'
          ) AS item
          FROM correction_requests cr
          LEFT JOIN consultation_resolutions resolution ON resolution.request_id = cr.id
          LEFT JOIN correction_requests ending ON ending.group_id = cr.id AND ending.id <> cr.id
            AND ending.staff_id = st.id AND ending.store_id = s.id
          WHERE cr.staff_id = st.id AND cr.store_id = s.id
            AND (${requestId ?? null}::uuid IS NULL OR cr.id = ${requestId ?? null}::uuid)
            AND (cr.group_id IS NULL OR cr.group_id = cr.id)
            AND (${cursor?.id ?? null}::uuid IS NULL
              OR (cr.requested_at, cr.id) < (${cursor?.requestedAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
          ORDER BY cr.requested_at DESC, cr.id DESC LIMIT 21
        ) page
      ), '[]'::jsonb) AS requests
      FROM staff st JOIN stores s ON s.id = st.store_id
      JOIN store_entry_tokens token ON token.store_id = s.id
      WHERE st.line_user_id = ${identity.sub} AND st.status = 'active' AND s.status = 'active'
        AND token.token_hash = ${tokenHash} AND token.active = TRUE AND token.revoked_at IS NULL
        AND (token.expires_at IS NULL OR token.expires_at > NOW())
      LIMIT 1
    `;
    if (memberships.length !== 1) {
      return NextResponse.json({ ok: false, code: "STAFF_OR_STORE_NOT_FOUND" }, { status: 404 });
    }
    const rows = memberships[0].requests as { id: string; requestedAt: string }[];
    const requests = rows.slice(0, 20);
    const last = requests.at(-1);
    return NextResponse.json({ ok: true, requests,
      next: rows.length > 20 && last ? { id: last.id, requestedAt: last.requestedAt } : null,
    }, { headers: { "Cache-Control": "no-store, private" } });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    logServerError("correction_history_failed", { route: "/api/correction-requests/history" });
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
