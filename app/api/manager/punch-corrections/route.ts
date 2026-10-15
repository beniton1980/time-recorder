import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";
import { LineTokenVerificationError, verifyLineIdToken } from "@/lib/line/verify-id-token";
import { enforceRateLimit } from "@/lib/api-security";

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
    !uuidPattern.test(body.staffId) ||
    !["ADD", "REPLACE", "VOID"].includes(operation) ||
    !reason ||
    reason.length > 500
  ) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  const limited = await enforceRateLimit(
    request,
    { scope: "manager-direct-correction", limit: 20, windowSeconds: 600 },
    body.idToken,
  );
  if (limited) return limited;

  if (
    operation !== "VOID" &&
    (!eventTypes.includes(eventType) || typeof body.occurredAt !== "string")
  ) {
    return NextResponse.json({ ok: false, code: "CORRECTION_FIELDS_REQUIRED" }, { status: 400 });
  }

  if (
    operation !== "ADD" &&
    (typeof body.targetEffectiveId !== "string" || !uuidPattern.test(body.targetEffectiveId))
  ) {
    return NextResponse.json({ ok: false, code: "INVALID_TARGET" }, { status: 400 });
  }

  const parsedOccurredAt = operation === "VOID" ? null : new Date(body.occurredAt as string);
  if (parsedOccurredAt && Number.isNaN(parsedOccurredAt.getTime())) {
    return NextResponse.json({ ok: false, code: "INVALID_OCCURRED_AT" }, { status: 400 });
  }

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({
      mode: "manager",
      lineIdentity: identity.sub,
      storeId: body.storeId as string,
    });

    const managers = await sql`
      SELECT st.id AS manager_id, st.store_id
      FROM staff st
      JOIN stores s ON s.id = st.store_id
      WHERE st.line_user_id = ${identity.sub}
        AND st.status = 'active' AND public.app_manager_store_allowed(st.store_id) AND s.status = 'active'
        AND st.store_id = ${body.storeId}::uuid
      LIMIT 1
    `;

    if (managers.length === 0) {
      return NextResponse.json({ ok: false, code: "MANAGER_ACCESS_REQUIRED" }, { status: 403 });
    }
    const manager = managers[0];

    const staff = await sql`
      SELECT id FROM staff
      WHERE id = ${body.staffId} AND store_id = ${manager.store_id}
      LIMIT 1
    `;
    if (staff.length === 0) {
      return NextResponse.json({ ok: false, code: "STAFF_NOT_FOUND" }, { status: 404 });
    }

    let targetEventId: string | null = null;
    let targetCorrectionId: string | null = null;

    if (operation !== "ADD") {
      if (typeof body.targetEffectiveId !== "string") {
        return NextResponse.json({ ok: false, code: "TARGET_REQUIRED" }, { status: 400 });
      }
      const targets = await sql`
        SELECT effective_id, original_event_id, origin_correction_id
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
    }

    const inserted = await sql`
      SELECT correction_id AS id, operation, status
      FROM public.apply_manager_direct_correction(
        ${manager.store_id}::uuid,
        ${body.staffId}::uuid,
        ${operation},
        ${targetEventId}::uuid,
        ${targetCorrectionId}::uuid,
        ${operation === "VOID" ? null : eventType},
        ${operation === "VOID" ? null : parsedOccurredAt!.toISOString()}::timestamptz,
        ${reason}
      )
    `;

    return NextResponse.json({ ok: true, correction: inserted[0] });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    if (error instanceof Error && error.message.includes("OCCURRED_AT_IN_FUTURE")) {
      return NextResponse.json({ ok: false, code: "OCCURRED_AT_IN_FUTURE" }, { status: 400 });
    }
    if (error instanceof Error) {
      for (const code of ["INVALID_PUNCH_SEQUENCE", "DUPLICATE_PUNCH_TIME", "TARGET_NOT_FOUND"]) {
        if (error.message.includes(code)) {
          return NextResponse.json({ ok: false, code }, { status: code === "TARGET_NOT_FOUND" ? 404 : 422 });
        }
      }
    }
    logServerError("manager_direct_correction_failed");
    return NextResponse.json(
      { ok: false, code: "CORRECTION_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
