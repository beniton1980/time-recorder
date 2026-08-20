import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";
import { enforceRateLimit } from "@/lib/api-security";
import {
  OperatorAccessError,
  operatorErrorResponse,
  verifyOperator,
} from "@/lib/onboarding/verify-operator";
import { sendManagerInviteMail } from "@/lib/onboarding/send-manager-invite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProvisionRequest = {
  idToken?: unknown;
  requestId?: unknown;
};

const LIFF_ID = "2010761826-6FNSE1PD";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function tokenHash(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function POST(request: Request) {
  let body: ProvisionRequest;

  try {
    body = (await request.json()) as ProvisionRequest;
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

  const limited = await enforceRateLimit(request, { scope: "operator-onboarding-provision", limit: 20, windowSeconds: 300 }, typeof body.idToken === "string" ? body.idToken : undefined);
  if (limited) return limited;

  try {
    const operator = await verifyOperator(body.idToken);
    const rawToken = randomBytes(32).toString("base64url");
    const sql = getSql({ mode: "operator", lineIdentity: operator.sub });

    const provisioned = await sql`
      SELECT *
      FROM provision_onboarding_request(
        ${body.requestId}::uuid,
        ${tokenHash(rawToken)},
        ${operator.sub}
      )
    `;

    const result = provisioned[0];
    const inviteUrl = `https://liff.line.me/${LIFF_ID}/onboarding/invite?token=${encodeURIComponent(rawToken)}`;
    const recipients = await sql`
      SELECT contact_email, manager_legal_name
      FROM onboarding_requests
      WHERE id = ${body.requestId}::uuid
    `;
    let email: Awaited<ReturnType<typeof sendManagerInviteMail>>;

    try {
      email = await sendManagerInviteMail({
        requestId: body.requestId,
        recipient: recipients[0].contact_email,
        managerName: recipients[0].manager_legal_name,
        storeName: result.store_name,
        inviteUrl,
        expiresAt: result.invite_expires_at,
      });
    } catch {
      logServerError("manager_invite_email_delivery_failed");
      email = { sent: false, code: "EMAIL_DELIVERY_FAILED" };
    }

    return NextResponse.json(
      {
        ok: true,
        store: {
          id: result.store_id,
          name: result.store_name,
          status: "suspended",
        },
        managerInvite: {
          url: inviteUrl,
          expiresAt: result.invite_expires_at,
          email,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof OperatorAccessError) {
      const response = operatorErrorResponse(error);
      return NextResponse.json(response.body, { status: response.status });
    }

    const message = error instanceof Error ? error.message : "";
    const knownCodes = [
      "ONBOARDING_REQUEST_NOT_FOUND",
      "ONBOARDING_REQUEST_ALREADY_PROVISIONED",
      "ONBOARDING_REQUEST_NOT_APPROVED",
    ];
    const code = knownCodes.find((candidate) => message.includes(candidate));

    if (code) {
      return NextResponse.json(
        { ok: false, code },
        {
          status: code === "ONBOARDING_REQUEST_NOT_FOUND"
            ? 404
            : code === "ONBOARDING_REQUEST_ALREADY_PROVISIONED"
              ? 409
              : 422,
        },
      );
    }

    logServerError("onboarding_provisioning_failed");
    return NextResponse.json(
      { ok: false, code: "ONBOARDING_PROVISIONING_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
