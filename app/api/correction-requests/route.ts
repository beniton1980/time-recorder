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

type EventType = (typeof eventTypes)[number];
type CorrectionCategory = "MISTAKE" | "MISSED" | "OTHER";

type CorrectionRequestBody = {
  idToken?: unknown;
  storeToken?: unknown;
  category?: unknown;
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
  const category =
    body.category === "MISTAKE" ||
    body.category === "MISSED" ||
    body.category === "OTHER"
      ? (body.category as CorrectionCategory)
      : null;

  if (typeof body.idToken !== "string" || !tokenHash || !category) {
    return NextResponse.json(
      { ok: false, code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql();

    const membership = await sql`
      SELECT
        s.id AS store_id,
        st.id AS staff_id,
        ss.last_event_id,
        pe.event_type AS last_event_type,
        pe.occurred_at AS last_event_at
      FROM staff st
      JOIN stores s ON s.id = st.store_id
      JOIN store_entry_tokens setk ON setk.store_id = s.id
      JOIN staff_states ss ON ss.staff_id = st.id
      LEFT JOIN punch_events pe ON pe.id = ss.last_event_id
      WHERE st.line_user_id = ${identity.sub}
        AND st.status = 'active'
        AND s.status = 'active'
        AND setk.token_hash = ${tokenHash}
        AND setk.active = TRUE
        AND setk.revoked_at IS NULL
        AND (setk.expires_at IS NULL OR setk.expires_at > NOW())
      ORDER BY st.created_at ASC
      LIMIT 1
    `;

    if (membership.length !== 1) {
      return NextResponse.json(
        { ok: false, code: "STAFF_OR_STORE_NOT_FOUND" },
        { status: 404 },
      );
    }

    const member = membership[0];
    let operation: "ADD" | "REPLACE" | "REVIEW";
    let targetEventId: string | null = null;
    let requestedEventType: EventType | null = null;
    let requestedOccurredAt: string | null = null;
    let reason: string;

    if (category === "MISTAKE") {
      if (
        !member.last_event_id ||
        !member.last_event_at ||
        (member.last_event_type !== "CHECK_OUT" &&
          member.last_event_type !== "BREAK_START")
      ) {
        return NextResponse.json(
          { ok: false, code: "LAST_PUNCH_NOT_CORRECTABLE" },
          { status: 409 },
        );
      }

      operation = "REPLACE";
      targetEventId = String(member.last_event_id);
      requestedEventType =
        member.last_event_type === "CHECK_OUT" ? "BREAK_START" : "CHECK_OUT";
      requestedOccurredAt = new Date(
        String(member.last_event_at),
      ).toISOString();
      reason = "前回の打刻ボタンを押し間違えた";
    } else if (category === "MISSED") {
      const eventType =
        typeof body.eventType === "string" &&
        eventTypes.includes(body.eventType as EventType)
          ? (body.eventType as EventType)
          : null;
      const occurredAt =
        typeof body.occurredAt === "string" ? new Date(body.occurredAt) : null;

      if (!eventType || !occurredAt || Number.isNaN(occurredAt.getTime())) {
        return NextResponse.json(
          { ok: false, code: "MISSED_PUNCH_DETAILS_REQUIRED" },
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

      operation = "ADD";
      requestedEventType = eventType;
      requestedOccurredAt = occurredAt.toISOString();
      reason = "打刻を押し忘れた";
    } else {
      const otherReason =
        typeof body.reason === "string" ? body.reason.trim() : "";

      if (otherReason.length < 1 || otherReason.length > 500) {
        return NextResponse.json(
          { ok: false, code: "OTHER_REASON_REQUIRED" },
          { status: 400 },
        );
      }

      operation = "REVIEW";
      reason = otherReason;
    }

    const inserted = await sql`
      INSERT INTO correction_requests (
        store_id,
        staff_id,
        operation,
        target_event_id,
        requested_event_type,
        requested_occurred_at,
        reason,
        status
      )
      VALUES (
        ${String(member.store_id)}::uuid,
        ${String(member.staff_id)}::uuid,
        ${operation},
        ${targetEventId}::uuid,
        ${requestedEventType},
        ${requestedOccurredAt}::timestamptz,
        ${reason},
        'PENDING'
      )
      RETURNING
        id,
        operation,
        target_event_id,
        requested_event_type,
        requested_occurred_at,
        reason,
        status,
        requested_at
    `;

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
