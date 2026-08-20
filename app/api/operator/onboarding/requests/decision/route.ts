import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";
import { enforceRateLimit } from "@/lib/api-security";
import {
  OperatorAccessError,
  operatorErrorResponse,
  verifyOperator,
} from "@/lib/onboarding/verify-operator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DecisionRequest = {
  idToken?: unknown;
  requestId?: unknown;
  decision?: unknown;
  rejectionReason?: unknown;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  let body: DecisionRequest;

  try {
    body = (await request.json()) as DecisionRequest;
  } catch {
    return NextResponse.json(
      { ok: false, code: "INVALID_JSON" },
      { status: 400 },
    );
  }

  if (typeof body.requestId !== "string" || !uuidPattern.test(body.requestId)) {
    return NextResponse.json(
      { ok: false, code: "INVALID_REQUEST_ID" },
      { status: 400 },
    );
  }

  if (body.decision !== "APPROVED" && body.decision !== "REJECTED") {
    return NextResponse.json(
      { ok: false, code: "INVALID_DECISION" },
      { status: 400 },
    );
  }

  const rejectionReason =
    typeof body.rejectionReason === "string"
      ? body.rejectionReason.trim().slice(0, 500)
      : "";

  if (body.decision === "REJECTED" && rejectionReason.length === 0) {
    return NextResponse.json(
      { ok: false, code: "REJECTION_REASON_REQUIRED" },
      { status: 400 },
    );
  }

  const limited = await enforceRateLimit(request, { scope: "operator-onboarding-decision", limit: 20, windowSeconds: 300 }, typeof body.idToken === "string" ? body.idToken : undefined);
  if (limited) return limited;

  try {
    const operator = await verifyOperator(body.idToken);
    const sql = getSql({ mode: "operator", lineIdentity: operator.sub });

    const updated = await sql`
      UPDATE onboarding_requests
      SET
        status = ${body.decision},
        reviewed_by_line_user_id = ${operator.sub},
        reviewed_at = NOW(),
        rejection_reason = ${body.decision === "REJECTED" ? rejectionReason : null},
        updated_at = NOW()
      WHERE id = ${body.requestId}::uuid
        AND status = 'PENDING'
      RETURNING id, status, reviewed_at
    `;

    if (updated.length === 0) {
      const existing = await sql`
        SELECT status
        FROM onboarding_requests
        WHERE id = ${body.requestId}::uuid
        LIMIT 1
      `;

      return NextResponse.json(
        {
          ok: false,
          code: existing.length === 0
            ? "ONBOARDING_REQUEST_NOT_FOUND"
            : "ONBOARDING_REQUEST_ALREADY_REVIEWED",
        },
        { status: existing.length === 0 ? 404 : 409 },
      );
    }

    return NextResponse.json({ ok: true, request: updated[0] });
  } catch (error) {
    if (error instanceof OperatorAccessError) {
      const response = operatorErrorResponse(error);
      return NextResponse.json(response.body, { status: response.status });
    }

    logServerError("onboarding_decision_failed");
    return NextResponse.json(
      { ok: false, code: "ONBOARDING_DECISION_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
