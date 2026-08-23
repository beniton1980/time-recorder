import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { clientRequestId?: unknown; token?: unknown };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function tokenHash(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 });
  }

  if (
    typeof body.clientRequestId !== "string"
    || !uuidPattern.test(body.clientRequestId)
    || typeof body.token !== "string"
    || body.token.length < 32
    || body.token.length > 256
  ) {
    return NextResponse.json(
      { ok: false, code: "EMAIL_VERIFICATION_INVALID" },
      { status: 400 },
    );
  }

  const limited = await enforceRateLimit(
    request,
    { scope: "onboarding-email-verification", limit: 10, windowSeconds: 600 },
    body.token,
  );
  if (limited) return limited;

  try {
    const sql = getSql({
      mode: "onboarding_public",
      clientRequestId: body.clientRequestId,
    });
    const verified = await sql`
      UPDATE onboarding_requests
      SET contact_email_verified_at = NOW(),
          contact_email_verification_token_hash = NULL,
          contact_email_verification_expires_at = NULL,
          updated_at = NOW()
      WHERE client_request_id = ${body.clientRequestId}::uuid
        AND status = 'APPROVED'
        AND contact_email_verification_token_hash = ${tokenHash(body.token)}
        AND contact_email_verification_expires_at > NOW()
      RETURNING id
    `;

    if (verified.length === 0) {
      return NextResponse.json(
        { ok: false, code: "EMAIL_VERIFICATION_INVALID" },
        { status: 400 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch {
    logServerError("contact_email_verification_failed");
    return NextResponse.json(
      { ok: false, code: "EMAIL_VERIFICATION_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
