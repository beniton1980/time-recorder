import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { LineTokenVerificationError, verifyLineIdToken } from "@/lib/line/verify-id-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const eventTypes = ["CHECK_IN", "BREAK_START", "BREAK_END", "CHECK_OUT"] as const;
type EventType = (typeof eventTypes)[number];
type Operation = "ADD" | "REPLACE" | "VOID";

type Body = {
  idToken?: unknown;
  storeId?: unknown;
  staffId?: unknown;
  operation?: unknown;
  targetEffectiveId?: unknown;
  eventType?: unknown;
  occurredAt?: unknown;
  reason?: unknown;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type EventRow = { effective_id: string; event_type: EventType; occurred_at: string };

function normalizeDate(value: unknown) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  if (!match) throw new Error("BUSINESS_DATE_INVALID");
  return match[0];
}

function invalidTransitions(events: EventRow[]) {
  let state: "OFF_DUTY" | "WORKING" | "ON_BREAK" = "OFF_DUTY";
  let invalid = 0;
  for (const event of events) {
    const allowed =
      (state === "OFF_DUTY" && event.event_type === "CHECK_IN") ||
      (state === "WORKING" && (event.event_type === "BREAK_START" || event.event_type === "CHECK_OUT")) ||
      (state === "ON_BREAK" && event.event_type === "BREAK_END");
    if (!allowed) {
      invalid += 1;
      continue;
    }
    state =
      event.event_type === "CHECK_OUT"
        ? "OFF_DUTY"
        : event.event_type === "BREAK_START"
          ? "ON_BREAK"
          : "WORKING";
  }
  return invalid;
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 });
  }

  const operation = body.operation as Operation;
  const eventType = body.eventType as EventType;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  if (
    typeof body.idToken !== "string" ||
    typeof body.storeId !== "string" ||
    !uuidPattern.test(body.storeId) ||
    typeof body.staffId !== "string" ||
    !["ADD", "REPLACE", "VOID"].includes(operation) ||
    !reason
  ) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  if (
    operation !== "VOID" &&
    (!eventTypes.includes(eventType) || typeof body.occurredAt !== "string")
  ) {
    return NextResponse.json({ ok: false, code: "CORRECTION_FIELDS_REQUIRED" }, { status: 400 });
  }

  const parsedOccurredAt = operation === "VOID" ? null : new Date(body.occurredAt as string);
  if (parsedOccurredAt && Number.isNaN(parsedOccurredAt.getTime())) {
    return NextResponse.json({ ok: false, code: "INVALID_OCCURRED_AT" }, { status: 400 });
  }

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql();

    const managers = await sql`
      SELECT st.id AS manager_id, st.store_id
      FROM staff st
      JOIN stores s ON s.id = st.store_id
      WHERE st.line_user_id = ${identity.sub}
        AND st.status = 'active' AND st.role = 'MANAGER' AND s.status = 'active'
        AND st.store_id = ${body.storeId}::uuid
      LIMIT 1
    `;

    if (managers.length === 0) {
      return NextResponse.json({ ok: false, code: "MANAGER_ACCESS_REQUIRED" }, { status: 403 });
    }
    const manager = managers[0];

    const staff = await sql`
      SELECT id FROM staff
      WHERE id = ${body.staffId} AND store_id = ${manager.store_id} AND status = 'active'
      LIMIT 1
    `;
    if (staff.length === 0) {
      return NextResponse.json({ ok: false, code: "STAFF_NOT_FOUND" }, { status: 404 });
    }

    let targetEventId: string | null = null;
    let targetCorrectionId: string | null = null;
    let businessDate: string;

    if (operation === "ADD") {
      const dates = await sql`
        SELECT (((${parsedOccurredAt!.toISOString()}::timestamptz AT TIME ZONE timezone)
          - make_interval(mins => business_day_start_minute)))::date AS business_date
        FROM stores WHERE id = ${manager.store_id}
      `;
      businessDate = normalizeDate(dates[0].business_date);
    } else {
      if (typeof body.targetEffectiveId !== "string") {
        return NextResponse.json({ ok: false, code: "TARGET_REQUIRED" }, { status: 400 });
      }
      const targets = await sql`
        SELECT effective_id, original_event_id, origin_correction_id, business_date
        FROM effective_punch_events
        WHERE effective_id = ${body.targetEffectiveId}
          AND staff_id = ${body.staffId}
          AND store_id = ${manager.store_id}
        LIMIT 1
      `;
      if (targets.length === 0) {
        return NextResponse.json({ ok: false, code: "TARGET_NOT_FOUND" }, { status: 404 });
      }
      targetEventId = targets[0].original_event_id as string | null;
      targetCorrectionId = targets[0].origin_correction_id as string | null;
      businessDate = normalizeDate(targets[0].business_date);
    }

    const current = (await sql`
      SELECT effective_id, event_type, occurred_at
      FROM effective_punch_events
      WHERE staff_id = ${body.staffId} AND business_date = ${businessDate}
      ORDER BY occurred_at ASC, created_at ASC, effective_id ASC
    `) as EventRow[];

    const beforeInvalid = invalidTransitions(current);
    let prospective = current.filter((event) => event.effective_id !== body.targetEffectiveId);

    if (operation !== "VOID") {
      const occurredAt = parsedOccurredAt!.toISOString();
      if (prospective.some((event) => new Date(event.occurred_at).getTime() === parsedOccurredAt!.getTime())) {
        return NextResponse.json({ ok: false, code: "DUPLICATE_PUNCH_TIME" }, { status: 422 });
      }
      prospective.push({
        effective_id: operation === "ADD" ? "new" : String(body.targetEffectiveId),
        event_type: eventType,
        occurred_at: occurredAt,
      });
    }

    prospective.sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
    const afterInvalid = invalidTransitions(prospective);

    if (afterInvalid > 0 && afterInvalid >= beforeInvalid) {
      return NextResponse.json(
        { ok: false, code: "INVALID_PUNCH_SEQUENCE", invalidTransitions: afterInvalid },
        { status: 422 },
      );
    }

    const inserted = await sql`
      INSERT INTO correction_requests (
        store_id, staff_id, operation, target_event_id, target_correction_id,
        requested_event_type, requested_occurred_at, reason, status,
        requested_at, approved_by, approved_at, created_at
      )
      VALUES (
        ${manager.store_id}, ${body.staffId}, ${operation},
        ${targetEventId}, ${targetCorrectionId},
        ${operation === "VOID" ? null : eventType},
        ${operation === "VOID" ? null : parsedOccurredAt!.toISOString()},
        ${reason}, 'APPROVED', NOW(), ${manager.manager_id}::text, NOW(), NOW()
      )
      RETURNING id, operation, status
    `;

    const latest = await sql`
      SELECT event_type, occurred_at, original_event_id
      FROM effective_punch_events
      WHERE staff_id = ${body.staffId}
      ORDER BY occurred_at DESC, effective_id DESC LIMIT 1
    `;
    if (latest.length > 0) {
      const lastType = latest[0].event_type as string;
      const state = lastType === "CHECK_OUT" ? "OFF_DUTY" : lastType === "BREAK_START" ? "ON_BREAK" : "WORKING";
      await sql`
        INSERT INTO staff_states (staff_id, state, last_event_id, last_event_at, updated_at)
        VALUES (${body.staffId}, ${state}, ${latest[0].original_event_id}, ${latest[0].occurred_at}, NOW())
        ON CONFLICT (staff_id) DO UPDATE SET
          state = EXCLUDED.state, last_event_id = EXCLUDED.last_event_id,
          last_event_at = EXCLUDED.last_event_at, updated_at = NOW()
      `;
    }

    return NextResponse.json({ ok: true, correction: inserted[0] });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    console.error("Manager direct correction failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json(
      {
        ok: false,
        code: "CORRECTION_UNAVAILABLE",
        detail: error instanceof Error ? error.message : "UNKNOWN_ERROR",
      },
      { status: 503 },
    );
  }
}
