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

type OperatorRequest = {
  idToken?: unknown;
  status?: unknown;
};

const allowedStatuses = new Set([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "PROVISIONED",
]);

export async function POST(request: Request) {
  let body: OperatorRequest;

  try {
    body = (await request.json()) as OperatorRequest;
  } catch {
    return NextResponse.json(
      { ok: false, code: "INVALID_JSON" },
      { status: 400 },
    );
  }

  const limited = await enforceRateLimit(request, { scope: "operator-onboarding-list", limit: 60, windowSeconds: 300 }, typeof body.idToken === "string" ? body.idToken : undefined);
  if (limited) return limited;

  try {
    const operator = await verifyOperator(body.idToken);

    const status = body.status ?? "PENDING";
    if (typeof status !== "string" || !allowedStatuses.has(status)) {
      return NextResponse.json(
        { ok: false, code: "INVALID_STATUS" },
        { status: 400 },
      );
    }

    const sql = getSql({ mode: "operator", lineIdentity: operator.sub });
    const requests = await sql`
      SELECT
        id,
        business_name,
        store_name,
        manager_legal_name,
        contact_email,
        store_address,
        business_category,
        staff_count_range,
        store_count_range,
        prior_attendance_method,
        reported_acquisition_source,
        timezone,
        business_day_start_minute,
        closing_rule,
        status,
        submitted_at,
        reviewed_at,
        rejection_reason,
        contact_email_verification_sent_at,
        contact_email_verified_at
      FROM onboarding_requests
      WHERE status = ${status}
        AND archived_at IS NULL
      ORDER BY submitted_at ASC
      LIMIT 100
    `;

    return NextResponse.json({ ok: true, requests });
  } catch (error) {
    if (error instanceof OperatorAccessError) {
      const response = operatorErrorResponse(error);
      return NextResponse.json(response.body, { status: response.status });
    }

    logServerError("onboarding_request_listing_failed");
    return NextResponse.json(
      { ok: false, code: "ONBOARDING_LIST_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
