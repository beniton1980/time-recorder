import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";
import { hashStoreEntryToken } from "@/lib/store-entry-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const eventTypes = [
  "CHECK_IN",
  "BREAK_START",
  "BREAK_END",
  "CHECK_OUT",
] as const;

type CorrectionRequestBody = {
  idToken?: unknown;
  storeToken?: unknown;
  eventType?: unknown;
  occurredAt?: unknown;
  reason?: unknown;
};

export async function POST(request: Request) {
  let body: CorrectionRequestBody;

  try {
    body = (await request.json()) as CorrectionRequestBody;
  } catch {
    return NextResponse.json(
      { ok: false, code: "INVALID_JSON" },
      { status: 400 },
    );
  }

  const tokenHash = hashStoreEntryToken(body.storeToken);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const occurredAt =
    typeof body.occurredAt === "string" ? new Date(body.occurredAt) : null;
  const eventType =
    typeof body.eventType === "string" &&
    eventTypes.includes(body.eventType as (typeof eventTypes)[number])
      ? (body.eventType as (typeof eventTypes)[number])
      : null;

  if (
    typeof body.idToken !== "string" ||
    !tokenHash ||
    !eventType ||
    !occurredAt ||
    Number.isNaN(occurredAt.getTime()) ||
    reason.length < 1 ||
    reason.length > 500
  ) {
    return NextResponse.json(
      { ok: false, code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }

  const now = Date.now();
  const oldestAllowed = now - 62 * 24 * 60 * 60 * 1000;
  const newestAllowed = now + 5 * 60 * 1000;

  if (
    occurredAt.getTime() < oldestAllowed ||
    occurredAt.getTime() > newestAllowed
  ) {
    return NextResponse.json(
      { ok: false, code: "OCCURRED_AT_OUT_OF_RANGE" },
      { status: 400 },
    );
  }

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql();

    const inserted = await sql`
      INSERT INTO correction_requests (
        store_id,
        staff_id,
        operation,
        requested_event_type,
        requested_occurred_at,
        reason,
        status
      )
      SELECT
        s.id,
        st.id,
        'ADD',
        ${eventType},
        ${occurredAt.toISOString()}::timestamptz,
        ${reason},
        'PENDING'
      FROM staff st
      JOIN stores s ON s.id = st.store_id
      JOIN store_entry_tokens setk ON setk.store_id = s.id
      WHERE st.line_user_id = ${identity.sub}
        AND st.status = 'active'
        AND s.status = 'active'
        AND setk.token_hash = ${tokenHash}
        AND setk.active = TRUE
        AND setk.revoked_at IS NULL
        AND (setk.expires_at IS NULL OR setk.expires_at > NOW())
      ORDER BY st.created_at ASC
      LIMIT 1
      RETURNING
        id,
        operation,
        requested_event_type,
        requested_occurred_at,
        reason,
        status,
        requested_at
    `;

    if (inserted.length !== 1) {
      return NextResponse.json(
        { ok: false, code: "STAFF_OR_STORE_NOT_FOUND" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ok: true,
      status: "submitted",
      correctionRequest: inserted[0],
    });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json(
        { ok: false, code: "INVALID_ID_TOKEN" },
        { status: 401 },
      );
    }

    console.error("Correction request failed", error);

    return NextResponse.json(
      { ok: false, code: "CORRECTION_REQUEST_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
