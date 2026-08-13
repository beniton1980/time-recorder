import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";
import { enforceRateLimit } from "@/lib/api-security";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const eventTypes = ["CHECK_IN", "BREAK_START", "BREAK_END", "CHECK_OUT"] as const;
type EventType = (typeof eventTypes)[number];

type DecisionRequest = {
  idToken?: unknown;
  storeId?: unknown;
  requestId?: unknown;
  decision?: unknown;
  resolvedEventType?: unknown;
  resolvedOccurredAt?: unknown;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && eventTypes.includes(value as EventType);
}

export async function POST(request: Request) {
  let body: DecisionRequest;
  try {
    body = (await request.json()) as DecisionRequest;
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 });
  }

  if (
    typeof body.idToken !== "string" ||
    typeof body.storeId !== "string" ||
    !uuidPattern.test(body.storeId) ||
    typeof body.requestId !== "string" ||
    !uuidPattern.test(body.requestId) ||
    (body.decision !== "APPROVED" && body.decision !== "REJECTED")
  ) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  const limited = await enforceRateLimit(request, { scope: "manager-correction-decision", limit: 30, windowSeconds: 300 }, body.idToken);
  if (limited) return limited;

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql();

    const managers = await sql`
      SELECT st.id AS staff_id, st.store_id
      FROM staff st
      JOIN stores s ON s.id = st.store_id
      WHERE st.line_user_id = ${identity.sub}
        AND st.status = 'active'
        AND st.role = 'MANAGER'
        AND s.status = 'active'
        AND st.store_id = ${body.storeId}::uuid
      ORDER BY st.created_at ASC
      LIMIT 1
    `;

    if (managers.length === 0) {
      return NextResponse.json({ ok: false, code: "MANAGER_ACCESS_REQUIRED" }, { status: 403 });
    }

    const manager = managers[0];

    const pending = await sql`
      SELECT id, staff_id, operation, requested_event_type, requested_occurred_at
      FROM correction_requests
      WHERE id = ${body.requestId}
        AND store_id = ${manager.store_id}
        AND status = 'PENDING'
      LIMIT 1
    `;

    if (pending.length === 0) {
      return NextResponse.json({ ok: false, code: "REQUEST_NOT_PENDING" }, { status: 409 });
    }

    const correction = pending[0];
    const isManualResolution =
      body.decision === "APPROVED" && correction.operation === "REVIEW";

    let resolvedOccurredAt: string | null = null;

    if (isManualResolution) {
      if (!isEventType(body.resolvedEventType) || typeof body.resolvedOccurredAt !== "string") {
        return NextResponse.json({ ok: false, code: "RESOLUTION_REQUIRED" }, { status: 422 });
      }

      const parsed = new Date(body.resolvedOccurredAt);
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json({ ok: false, code: "INVALID_RESOLUTION_TIME" }, { status: 422 });
      }

      resolvedOccurredAt = parsed.toISOString();
    } else if (body.decision === "APPROVED" && correction.operation !== "ADD") {
      return NextResponse.json({ ok: false, code: "UNSUPPORTED_APPROVAL" }, { status: 422 });
    }

    const updated = await sql`
      UPDATE correction_requests
      SET
        operation = CASE
          WHEN ${isManualResolution} THEN 'ADD'
          ELSE operation
        END,
        requested_event_type = CASE
          WHEN ${isManualResolution} THEN ${isManualResolution ? body.resolvedEventType : null}
          ELSE requested_event_type
        END,
        requested_occurred_at = CASE
          WHEN ${isManualResolution} THEN ${resolvedOccurredAt}
          ELSE requested_occurred_at
        END,
        status = ${body.decision},
        approved_by = CASE
          WHEN ${body.decision} = 'APPROVED' THEN ${manager.staff_id}::text
          ELSE approved_by
        END,
        approved_at = CASE
          WHEN ${body.decision} = 'APPROVED' THEN NOW()
          ELSE approved_at
        END,
        rejected_at = CASE
          WHEN ${body.decision} = 'REJECTED' THEN NOW()
          ELSE rejected_at
        END
      WHERE id = ${body.requestId}
        AND status = 'PENDING'
      RETURNING id, staff_id, status, operation, requested_event_type, requested_occurred_at
    `;

    if (updated.length === 0) {
      return NextResponse.json({ ok: false, code: "REQUEST_ALREADY_DECIDED" }, { status: 409 });
    }

    if (body.decision === "APPROVED") {
      const latest = await sql`
        SELECT event_type, occurred_at, original_event_id
        FROM effective_punch_events
        WHERE staff_id = ${correction.staff_id}
        ORDER BY occurred_at DESC, effective_id DESC
        LIMIT 1
      `;

      if (latest.length > 0) {
        const eventType = latest[0].event_type as string;
        const nextState =
          eventType === "CHECK_OUT"
            ? "OFF_DUTY"
            : eventType === "BREAK_START"
              ? "ON_BREAK"
              : "WORKING";

        await sql`
          INSERT INTO staff_states (staff_id, state, last_event_id, last_event_at, updated_at)
          VALUES (
            ${correction.staff_id},
            ${nextState},
            ${latest[0].original_event_id},
            ${latest[0].occurred_at},
            NOW()
          )
          ON CONFLICT (staff_id) DO UPDATE
          SET
            state = EXCLUDED.state,
            last_event_id = EXCLUDED.last_event_id,
            last_event_at = EXCLUDED.last_event_at,
            updated_at = NOW()
        `;
      }
    }

    return NextResponse.json({ ok: true, request: updated[0] });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    logServerError("correction_decision_failed");
    return NextResponse.json({ ok: false, code: "DECISION_UNAVAILABLE" }, { status: 503 });
  }
}
