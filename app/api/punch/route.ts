import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const transitions = {
  CHECK_IN: { from: "OFF_DUTY", to: "WORKING" },
  BREAK_START: { from: "WORKING", to: "ON_BREAK" },
  BREAK_END: { from: "ON_BREAK", to: "WORKING" },
  CHECK_OUT: { from: "WORKING", to: "OFF_DUTY" },
} as const;

type EventType = keyof typeof transitions;

type PunchRequest = {
  idToken?: unknown;
  eventType?: unknown;
  clientRequestId?: unknown;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  let body: PunchRequest;

  try {
    body = (await request.json()) as PunchRequest;
  } catch {
    return NextResponse.json(
      { ok: false, code: "INVALID_JSON" },
      { status: 400 },
    );
  }

  if (
    typeof body.idToken !== "string" ||
    typeof body.eventType !== "string" ||
    !(body.eventType in transitions) ||
    typeof body.clientRequestId !== "string" ||
    !uuidPattern.test(body.clientRequestId)
  ) {
    return NextResponse.json(
      { ok: false, code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }

  const eventType = body.eventType as EventType;
  const transition = transitions[eventType];

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql();

    const existing = await sql`
      SELECT
        pe.id AS event_id,
        pe.event_type,
        pe.occurred_at,
        ss.state
      FROM punch_events pe
      JOIN staff st ON st.id = pe.staff_id
      JOIN staff_states ss ON ss.staff_id = st.id
      WHERE pe.client_request_id = ${body.clientRequestId}
        AND st.line_user_id = ${identity.sub}
      LIMIT 1
    `;

    if (existing.length === 1) {
      return NextResponse.json({
        ok: true,
        status: "already_applied",
        punch: existing[0],
      });
    }

    const result = await sql`
      WITH target AS (
        SELECT
          st.id AS staff_id,
          st.store_id,
          s.timezone,
          s.business_day_start_minute
        FROM staff st
        JOIN stores s ON s.id = st.store_id
        WHERE st.line_user_id = ${identity.sub}
          AND st.status = 'active'
          AND s.status = 'active'
        ORDER BY st.created_at ASC
        LIMIT 1
      ),
      claimed_state AS (
        UPDATE staff_states ss
        SET
          state = ${transition.to},
          updated_at = NOW()
        FROM target t
        WHERE ss.staff_id = t.staff_id
          AND ss.state = ${transition.from}
        RETURNING
          ss.staff_id,
          t.store_id,
          t.timezone,
          t.business_day_start_minute
      ),
      inserted_event AS (
        INSERT INTO punch_events (
          store_id,
          staff_id,
          event_type,
          occurred_at,
          business_date,
          client_request_id,
          location_status,
          validation_status,
          source
        )
        SELECT
          cs.store_id,
          cs.staff_id,
          ${eventType},
          NOW(),
          (
            (NOW() AT TIME ZONE cs.timezone)
            - make_interval(mins => cs.business_day_start_minute)
          )::date,
          ${body.clientRequestId},
          'UNAVAILABLE',
          'VALID',
          'LIFF'
        FROM claimed_state cs
        RETURNING id, staff_id, event_type, occurred_at
      )
      UPDATE staff_states ss
      SET
        last_event_id = ie.id,
        last_event_at = ie.occurred_at,
        updated_at = NOW()
      FROM inserted_event ie
      WHERE ss.staff_id = ie.staff_id
      RETURNING
        ie.id AS event_id,
        ie.event_type,
        ie.occurred_at,
        ss.state
    `;

    if (result.length === 1) {
      return NextResponse.json({
        ok: true,
        status: "applied",
        punch: result[0],
      });
    }

    const membership = await sql`
      SELECT ss.state
      FROM staff st
      JOIN stores s ON s.id = st.store_id
      JOIN staff_states ss ON ss.staff_id = st.id
      WHERE st.line_user_id = ${identity.sub}
        AND st.status = 'active'
        AND s.status = 'active'
      ORDER BY st.created_at ASC
      LIMIT 1
    `;

    if (membership.length === 0) {
      return NextResponse.json(
        { ok: false, code: "STAFF_NOT_REGISTERED" },
        { status: 404 },
      );
    }

    return NextResponse.json(
      {
        ok: false,
        code: "INVALID_STATE_TRANSITION",
        currentState: membership[0].state,
      },
      { status: 409 },
    );
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json(
        { ok: false, code: "INVALID_ID_TOKEN" },
        { status: 401 },
      );
    }

    console.error("Punch failed", error);

    return NextResponse.json(
      { ok: false, code: "PUNCH_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
