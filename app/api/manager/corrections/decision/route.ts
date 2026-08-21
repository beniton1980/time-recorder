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
    const sql = getSql({
      mode: "manager",
      lineIdentity: identity.sub,
      storeId: body.storeId as string,
    });

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
      SELECT
        correction_id AS id,
        staff_id,
        status,
        operation,
        requested_event_type,
        requested_occurred_at
      FROM public.decide_manager_correction(
        ${manager.store_id}::uuid,
        ${body.requestId}::uuid,
        ${body.decision},
        ${isManualResolution ? body.resolvedEventType : null},
        ${resolvedOccurredAt}::timestamptz
      )
    `;

    if (updated.length === 0) {
      return NextResponse.json({ ok: false, code: "REQUEST_ALREADY_DECIDED" }, { status: 409 });
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
