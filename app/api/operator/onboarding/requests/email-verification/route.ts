import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { getSql } from "@/lib/db";
import {
  OperatorAccessError,
  operatorErrorResponse,
  verifyOperator,
} from "@/lib/onboarding/verify-operator";
import { sendContactEmailVerificationMail } from "@/lib/onboarding/send-contact-email-verification";
import { logServerError } from "@/lib/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { idToken?: unknown; requestId?: unknown };

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

  if (typeof body.requestId !== "string" || !uuidPattern.test(body.requestId)) {
    return NextResponse.json(
      { ok: false, code: "INVALID_REQUEST_ID" },
      { status: 400 },
    );
  }

  const limited = await enforceRateLimit(
    request,
    { scope: "operator-onboarding-email-verification", limit: 10, windowSeconds: 600 },
    typeof body.idToken === "string" ? body.idToken : undefined,
  );
  if (limited) return limited;

  try {
    const operator = await verifyOperator(body.idToken);
    const rawToken = randomBytes(32).toString("base64url");
    const hash = tokenHash(rawToken);
    const sql = getSql({ mode: "operator", lineIdentity: operator.sub });
    const rows = await sql`
      UPDATE onboarding_requests
      SET contact_email_verification_token_hash = ${hash},
          contact_email_verification_expires_at = NOW() + INTERVAL '24 hours',
          contact_email_verification_sent_at = NULL,
          updated_at = NOW()
      WHERE id = ${body.requestId}::uuid
        AND status = 'APPROVED'
        AND contact_email_verified_at IS NULL
      RETURNING
        client_request_id,
        contact_email,
        manager_legal_name,
        store_name,
        contact_email_verification_expires_at
    `;

    if (rows.length === 0) {
      return NextResponse.json(
        { ok: false, code: "EMAIL_VERIFICATION_NOT_REQUIRED" },
        { status: 409 },
      );
    }

    const verificationUrl = new URL(
      "/onboarding/verify-email",
      "https://kintai.onogami.jp",
    );
    verificationUrl.searchParams.set(
      "request_id",
      String(rows[0].client_request_id),
    );
    verificationUrl.searchParams.set("token", rawToken);

    const email = await sendContactEmailVerificationMail({
      requestId: body.requestId,
      recipient: String(rows[0].contact_email),
      managerName: String(rows[0].manager_legal_name),
      storeName: String(rows[0].store_name),
      verificationUrl: verificationUrl.toString(),
      expiresAt: String(rows[0].contact_email_verification_expires_at),
      deliveryKey: hash.slice(0, 12),
    });

    if (email.sent) {
      await sql`
        UPDATE onboarding_requests
        SET contact_email_verification_sent_at = NOW(), updated_at = NOW()
        WHERE id = ${body.requestId}::uuid
          AND contact_email_verification_token_hash = ${hash}
      `;
    }

    return NextResponse.json({
      ok: true,
      email,
      expiresAt: rows[0].contact_email_verification_expires_at,
    });
  } catch (error) {
    if (error instanceof OperatorAccessError) {
      const response = operatorErrorResponse(error);
      return NextResponse.json(response.body, { status: response.status });
    }
    logServerError("contact_email_verification_delivery_failed");
    return NextResponse.json(
      { ok: false, code: "CONTACT_EMAIL_VERIFICATION_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
