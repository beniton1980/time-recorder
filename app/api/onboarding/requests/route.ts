import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";
import { validateOnboardingRequest } from "@/lib/onboarding/validation";
import { enforceRateLimit } from "@/lib/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: "INVALID_JSON" },
      { status: 400 },
    );
  }

  const validated = validateOnboardingRequest(body);
  if (!validated.ok) {
    return NextResponse.json(
      { ok: false, code: validated.code },
      { status: 400 },
    );
  }

  const limited = await enforceRateLimit(
    request,
    { scope: "onboarding-request", limit: 5, windowSeconds: 3600 },
  );
  if (limited) return limited;

  try {
    const sql = getSql();
    const input = validated.value;

    const inserted = await sql`
      INSERT INTO onboarding_requests (
        client_request_id,
        business_name,
        store_name,
        manager_legal_name,
        contact_email,
        store_address,
        timezone,
        business_day_start_minute,
        closing_rule,
        terms_accepted_at
      )
      VALUES (
        ${input.clientRequestId}::uuid,
        ${input.businessName},
        ${input.storeName},
        ${input.managerLegalName},
        ${input.contactEmail},
        ${input.storeAddress},
        ${input.timezone},
        ${input.businessDayStartMinute},
        ${input.closingRule},
        NOW()
      )
      ON CONFLICT (client_request_id) DO NOTHING
      RETURNING id, status, submitted_at
    `;

    const rows = inserted.length > 0
      ? inserted
      : await sql`
          SELECT id, status, submitted_at
          FROM onboarding_requests
          WHERE client_request_id = ${input.clientRequestId}::uuid
          LIMIT 1
        `;

    return NextResponse.json(
      {
        ok: true,
        request: rows[0],
        duplicate: inserted.length === 0,
      },
      { status: inserted.length > 0 ? 201 : 200 },
    );
  } catch {
    logServerError("onboarding_request_submission_failed");
    return NextResponse.json(
      { ok: false, code: "ONBOARDING_REQUEST_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
