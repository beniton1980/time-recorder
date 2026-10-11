import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";
import { enforceRateLimit } from "@/lib/api-security";
import { hashStoreEntryToken } from "@/lib/store-entry-token";
import { LineTokenVerificationError, verifyLineIdToken } from "@/lib/line/verify-id-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ValidationRequest = {
  idToken?: unknown;
  storeToken?: unknown;
  category?: unknown;
  eventType?: unknown;
  occurredAt?: unknown;
  breakEndedAt?: unknown;
};
const eventTypes = ["CHECK_IN", "BREAK_START", "BREAK_END", "CHECK_OUT"];

// Advisory check before the confirmation screen. The write/approval functions
// repeat the check under the staff-state lock; this response is never authority
// to skip validation when the user eventually submits.
export async function POST(request: Request) {
  let body: ValidationRequest;
  try { body = await request.json() as ValidationRequest; }
  catch { return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || typeof body.idToken !== "string"
    || (body.category !== "MISSED" && body.category !== "MISSED_BREAK")) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }
  const tokenHash = hashStoreEntryToken(body.storeToken);
  if (!tokenHash) return NextResponse.json({ ok: false, code: "STORE_TOKEN_REQUIRED" }, { status: 400 });
  const occurredAt = typeof body.occurredAt === "string" ? new Date(body.occurredAt) : null;
  if (typeof body.eventType !== "string" || !eventTypes.includes(body.eventType)
    || !occurredAt || !Number.isFinite(occurredAt.getTime())) {
    return NextResponse.json({ ok: false, code: "MISSED_PUNCH_DETAILS_REQUIRED" }, { status: 400 });
  }
  let breakEndedAt: Date | null = null;
  if (body.category === "MISSED_BREAK") {
    breakEndedAt = typeof body.breakEndedAt === "string" ? new Date(body.breakEndedAt) : null;
    if (body.eventType !== "BREAK_START" || !breakEndedAt || !Number.isFinite(breakEndedAt.getTime()) || breakEndedAt <= occurredAt) {
      return NextResponse.json({ ok: false, code: "INVALID_CORRECTION_REQUEST" }, { status: 400 });
    }
  }
  const limited = await enforceRateLimit(request,
    { scope: "correction-validation", limit: 60, windowSeconds: 300 }, body.idToken);
  if (limited) return limited;
  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({ mode: "staff", lineIdentity: identity.sub, storeTokenHash: tokenHash });
    const members = await sql`
      SELECT st.id AS staff_id, st.store_id
      FROM staff st
      JOIN stores s ON s.id = st.store_id
      JOIN store_entry_tokens setk ON setk.store_id = st.store_id
      WHERE st.line_user_id = ${identity.sub} AND st.status = 'active' AND s.status = 'active'
        AND setk.token_hash = ${tokenHash} AND setk.active = TRUE AND setk.revoked_at IS NULL
        AND (setk.expires_at IS NULL OR setk.expires_at > NOW())
      LIMIT 1
    `;
    if (members.length !== 1) return NextResponse.json({ ok: false, code: "STAFF_OR_STORE_NOT_FOUND" }, { status: 404 });
    const member = members[0];
    await sql`SELECT public.validate_correction_addition(
      ${String(member.store_id)}::uuid, ${String(member.staff_id)}::uuid,
      ${body.eventType}, ${occurredAt.toISOString()}::timestamptz,
      ${breakEndedAt?.toISOString() ?? null}::timestamptz
    )`;
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : "";
    const errors: Record<string, number> = {
      STAFF_OR_STORE_NOT_FOUND: 404, INVALID_CORRECTION_REQUEST: 400,
      OCCURRED_AT_OUT_OF_RANGE: 400, CORRECTION_BREAK_START_REQUIRED: 409,
      CORRECTION_SEQUENCE_INVALID: 409, CORRECTION_TIME_CONFLICT: 409, CORRECTION_PENDING_CONFLICT: 409,
    };
    for (const [code, status] of Object.entries(errors)) {
      if (message.includes(code)) return NextResponse.json({ ok: false, code }, { status });
    }
    logServerError("correction_validation_failed");
    return NextResponse.json({ ok: false, code: "CORRECTION_VALIDATION_UNAVAILABLE" }, { status: 503 });
  }
}
