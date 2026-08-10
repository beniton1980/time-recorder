import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { getSql } from "@/lib/db";
import { sendInitialStoreQrMail } from "@/lib/onboarding/send-initial-store-qr";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIFF_ID = "2010761826-6FNSE1PD";

type ClaimRequest = {
  idToken?: unknown;
  inviteToken?: unknown;
};

function tokenHash(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function POST(request: Request) {
  let body: ClaimRequest;

  try {
    body = (await request.json()) as ClaimRequest;
  } catch {
    return NextResponse.json(
      { ok: false, code: "INVALID_JSON" },
      { status: 400 },
    );
  }

  if (typeof body.idToken !== "string" || body.idToken.length === 0) {
    return NextResponse.json(
      { ok: false, code: "ID_TOKEN_REQUIRED" },
      { status: 400 },
    );
  }

  if (
    typeof body.inviteToken !== "string"
    || body.inviteToken.length < 40
    || body.inviteToken.length > 100
  ) {
    return NextResponse.json(
      { ok: false, code: "INVALID_INVITE_TOKEN" },
      { status: 400 },
    );
  }

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql();

    const claimed = await sql`
      SELECT *
      FROM claim_onboarding_manager_invite(
        ${tokenHash(body.inviteToken)},
        ${identity.sub}
      )
    `;

    const result = claimed[0];
    let storeQr: { entryUrl: string; qrPngDataUrl: string } | null = null;
    let storeQrEmail: Awaited<ReturnType<typeof sendInitialStoreQrMail>> | null = null;

    try {
      const rawStoreToken = randomBytes(32).toString("base64url");
      await sql`
        SELECT *
        FROM rotate_store_entry_token(
          ${result.store_id},
          ${tokenHash(rawStoreToken)}
        )
      `;
      const entryUrl = `https://liff.line.me/${LIFF_ID}?store_token=${encodeURIComponent(rawStoreToken)}`;
      const qrPngDataUrl = await QRCode.toDataURL(entryUrl, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 720,
      });
      storeQr = { entryUrl, qrPngDataUrl };

      const recipients = await sql`
        SELECT id, contact_email, manager_legal_name
        FROM onboarding_requests
        WHERE provisioned_store_id = ${result.store_id}
        LIMIT 1
      `;
      if (recipients.length > 0) {
        try {
          storeQrEmail = await sendInitialStoreQrMail({
            requestId: recipients[0].id,
            recipient: recipients[0].contact_email,
            managerName: recipients[0].manager_legal_name,
            storeName: result.store_name,
            qrPngDataUrl,
            managerUrl: `https://liff.line.me/${LIFF_ID}/manager/qr?store_id=${encodeURIComponent(result.store_id)}`,
          });
        } catch (mailError) {
          console.error("Initial store QR email delivery failed", {
            storeId: result.store_id,
            error: mailError instanceof Error ? mailError.name : "UnknownError",
          });
          storeQrEmail = { sent: false, code: "EMAIL_DELIVERY_FAILED" };
        }
      }
    } catch (qrError) {
      console.error("Initial store QR issuance failed", {
        storeId: result.store_id,
        error: qrError instanceof Error ? qrError.name : "UnknownError",
      });
    }

    return NextResponse.json({
      ok: true,
      manager: {
        staffId: result.staff_id,
        storeId: result.store_id,
        storeName: result.store_name,
      },
      storeQr,
      storeQrEmail,
    });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json(
        { ok: false, code: "INVALID_ID_TOKEN" },
        { status: 401 },
      );
    }

    const message = error instanceof Error ? error.message : "";
    if (message.includes("MANAGER_INVITE_INVALID")) {
      return NextResponse.json(
        { ok: false, code: "MANAGER_INVITE_INVALID" },
        { status: 410 },
      );
    }

    console.error("Manager invite claim failed", error);
    return NextResponse.json(
      { ok: false, code: "MANAGER_INVITE_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
