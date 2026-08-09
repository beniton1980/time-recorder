import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
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

  try {
    await verifyOperator(body.idToken);

    const status = body.status ?? "PENDING";
    if (typeof status !== "string" || !allowedStatuses.has(status)) {
      return NextResponse.json(
        { ok: false, code: "INVALID_STATUS" },
        { status: 400 },
      );
    }

    const sql = getSql();
    const requests = await sql`
      SELECT
        id,
        business_name,
        store_name,
        manager_legal_name,
        contact_email,
        store_address,
        timezone,
        business_day_start_minute,
        closing_rule,
        status,
        submitted_at,
        reviewed_at,
        rejection_reason
      FROM onboarding_requests
      WHERE status = ${status}
      ORDER BY submitted_at ASC
      LIMIT 100
    `;

    return NextResponse.json({ ok: true, requests });
  } catch (error) {
    if (error instanceof OperatorAccessError) {
      const response = operatorErrorResponse(error);
      return NextResponse.json(response.body, { status: response.status });
    }

    console.error("Onboarding request listing failed", error);
    return NextResponse.json(
      { ok: false, code: "ONBOARDING_LIST_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
