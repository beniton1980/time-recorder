import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DecisionRequest = {
  idToken?: unknown;
  requestId?: unknown;
  decision?: unknown;
};

export async function POST(request: Request) {
  let body: DecisionRequest;
  try {
    body = (await request.json()) as DecisionRequest;
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 });
  }

  if (
    typeof body.idToken !== "string" ||
    typeof body.requestId !== "string" ||
    (body.decision !== "APPROVED" && body.decision !== "REJECTED")
  ) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

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

    if (
      body.decision === "APPROVED" &&
      correction.operation !== "ADD"
    ) {
      return NextResponse.json(
        { ok: false, code: "MANUAL_EDIT_REQUIRED" },
        { status: 422 },
      );
    }

    const updated = await sql`
      UPDATE correction_requests
      SET
        status = ${body.decision},
        approved_by = CASE WHEN ${body.decision} = 'APPROVED' THEN ${manager.staff_id}::text ELSE approved_by END,
        approved_at = CASE WHEN ${body.decision} = 'APPROVED' THEN NOW() ELSE approved_at END,
        rejected_at = CASE WHEN ${body.decision} = 'REJECTED' THEN NOW() ELSE rejected_at END
      WHERE id = ${body.requestId}
        AND status = 'PENDING'
      RETURNING id, staff_id, status
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

    return NextResponse.json({
      ok: true,
      request: updated[0],
    });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    console.error("Correction decision failed", error);
    return NextResponse.json({ ok: false, code: "DECISION_UNAVAILABLE" }, { status: 503 });
  }
}
