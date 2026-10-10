import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";
import { LineTokenVerificationError, verifyLineIdToken } from "@/lib/line/verify-id-token";
import { hashStoreEntryToken } from "@/lib/store-entry-token";
import { enforceRateLimit } from "@/lib/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const eventTypes = ["CHECK_IN", "BREAK_START", "BREAK_END", "CHECK_OUT"];

type CorrectionRequestBody = {
  idToken?: unknown;
  storeToken?: unknown;
  clientRequestId?: unknown;
  category?: unknown;
  targetEventId?: unknown;
  expectedRevisionId?: unknown;
  eventType?: unknown;
  occurredAt?: unknown;
  reason?: unknown;
};

export async function POST(request: Request) {
  let body: CorrectionRequestBody;
  try {
    body = await request.json() as CorrectionRequestBody;
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }
  const tokenHash = hashStoreEntryToken(body.storeToken);
  const category = body.category;
  if (typeof body.idToken !== "string" || !tokenHash
    || (category !== "MISTAKE" && category !== "MISSED" && category !== "OTHER")) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }
  // Old open tabs must refresh rather than sending an unidentifiable toggle.
  if (typeof body.clientRequestId !== "string" || !uuidPattern.test(body.clientRequestId)) {
    return NextResponse.json({ ok: false, code: "CLIENT_REQUEST_ID_REQUIRED" }, { status: 400 });
  }

  let targetEventId: string | null = null;
  let expectedRevisionId: string | null = null;
  let eventType: string | null = null;
  let occurredAt: string | null = null;
  let reason: string | null = null;
  if (category === "MISTAKE") {
    if (typeof body.targetEventId !== "string" || !uuidPattern.test(body.targetEventId)
      || typeof body.expectedRevisionId !== "string" || !uuidPattern.test(body.expectedRevisionId)
      || (body.eventType !== "CHECK_OUT" && body.eventType !== "BREAK_START")) {
      return NextResponse.json({ ok: false, code: "CORRECTION_TARGET_REQUIRED" }, { status: 400 });
    }
    targetEventId = body.targetEventId;
    expectedRevisionId = body.expectedRevisionId;
    eventType = body.eventType;
  } else if (category === "MISSED") {
    const date = typeof body.occurredAt === "string" ? new Date(body.occurredAt) : null;
    if (typeof body.eventType !== "string" || !eventTypes.includes(body.eventType)
      || !date || Number.isNaN(date.getTime())) {
      return NextResponse.json({ ok: false, code: "MISSED_PUNCH_DETAILS_REQUIRED" }, { status: 400 });
    }
    eventType = body.eventType;
    occurredAt = date.toISOString();
  } else {
    reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason || reason.length > 500) {
      return NextResponse.json({ ok: false, code: "OTHER_REASON_REQUIRED" }, { status: 400 });
    }
  }

  const limited = await enforceRateLimit(
    request, { scope: "correction-request", limit: 20, windowSeconds: 600 }, body.idToken,
  );
  if (limited) return limited;

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({ mode: "staff", lineIdentity: identity.sub, storeTokenHash: tokenHash });
    const membership = await sql`
      SELECT s.id AS store_id, st.id AS staff_id
      FROM staff st
      JOIN stores s ON s.id = st.store_id
      JOIN store_entry_tokens setk ON setk.store_id = s.id
      WHERE st.line_user_id = ${identity.sub}
        AND st.status = 'active' AND s.status = 'active'
        AND setk.token_hash = ${tokenHash} AND setk.active = TRUE
        AND setk.revoked_at IS NULL
        AND (setk.expires_at IS NULL OR setk.expires_at > NOW())
      LIMIT 1
    `;
    if (membership.length !== 1) {
      return NextResponse.json({ ok: false, code: "STAFF_OR_STORE_NOT_FOUND" }, { status: 404 });
    }
    const member = membership[0];
    const result = await sql`
      SELECT * FROM public.submit_staff_correction(
        ${String(member.store_id)}::uuid, ${String(member.staff_id)}::uuid,
        ${body.clientRequestId}::uuid, ${category},
        ${targetEventId}::uuid, ${expectedRevisionId}::uuid,
        ${eventType}, ${occurredAt}::timestamptz, ${reason}
      )
    `;
    return NextResponse.json({
      ok: true, status: result[0].result_status, correctionRequest: result[0].correction_request,
    });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : "";
    const knownErrors: Record<string, number> = {
      LAST_PUNCH_CHANGED: 409,
      CLIENT_REQUEST_CONFLICT: 409,
      ACTIVE_AT_OTHER_STORE: 409,
      STAFF_OR_STORE_NOT_FOUND: 404,
      OCCURRED_AT_OUT_OF_RANGE: 400,
      INVALID_CORRECTION_REQUEST: 400,
    };
    for (const [code, status] of Object.entries(knownErrors)) {
      if (message.includes(code)) return NextResponse.json({ ok: false, code }, { status });
    }
    logServerError("correction_request_failed");
    return NextResponse.json({ ok: false, code: "CORRECTION_REQUEST_UNAVAILABLE" }, { status: 503 });
  }
}
