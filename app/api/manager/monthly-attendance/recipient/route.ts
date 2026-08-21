import { createHash, randomBytes } from "node:crypto";
import { enforceRateLimit } from "@/lib/api-security";
import { getSql } from "@/lib/db";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";
import { logServerError } from "@/lib/safe-log";
import { sendMonthlyReportRecipientVerification } from "@/lib/send-monthly-report-recipient-verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { idToken?: unknown; storeId?: unknown; email?: unknown };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function tokenHash(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 });
  }

  if (
    typeof body.idToken !== "string"
    || typeof body.storeId !== "string"
    || !uuidPattern.test(body.storeId)
  ) {
    return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  const limited = await enforceRateLimit(
    request,
    { scope: "manager-monthly-recipient", limit: 10, windowSeconds: 600 },
    body.idToken,
  );
  if (limited) return limited;

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length === 0 || email.length > 254 || !emailPattern.test(email)) {
    return Response.json({ ok: false, code: "INVALID_EMAIL" }, { status: 400 });
  }

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const rawToken = randomBytes(32).toString("base64url");
    const hash = tokenHash(rawToken);
    const sql = getSql({
      mode: "manager",
      lineIdentity: identity.sub,
      storeId: body.storeId,
    });
    const rows = await sql`
      SELECT *
      FROM public.set_monthly_report_recipient(
        ${body.storeId}::uuid,
        ${email},
        ${hash}
      )
    `;
    if (rows.length === 0) {
      return Response.json(
        { ok: false, code: "MANAGER_ACCESS_REQUIRED" },
        { status: 403 },
      );
    }

    const verificationUrl = new URL(
      "/monthly-attendance/verify-email",
      "https://kintai.onogami.jp",
    );
    verificationUrl.searchParams.set("store_id", body.storeId);
    verificationUrl.searchParams.set("token", rawToken);

    const delivery = await sendMonthlyReportRecipientVerification({
      storeId: body.storeId,
      storeName: String(rows[0].store_name),
      recipient: String(rows[0].recipient),
      verificationUrl: verificationUrl.toString(),
      expiresAt: String(rows[0].expires_at),
      deliveryKey: hash.slice(0, 12),
    });

    if (delivery.sent) {
      await sql`
        SELECT public.mark_monthly_report_verification_sent(
          ${body.storeId}::uuid,
          ${hash}
        )
      `;
    }

    return Response.json({ ok: true, email: delivery });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return Response.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : "";
    if (message.includes("MANAGER_ACCESS_REQUIRED")) {
      return Response.json(
        { ok: false, code: "MANAGER_ACCESS_REQUIRED" },
        { status: 403 },
      );
    }
    if (message.includes("MONTHLY_REPORT_RECIPIENT_ALREADY_CONFIRMED")) {
      return Response.json(
        { ok: false, code: "MONTHLY_REPORT_RECIPIENT_ALREADY_CONFIRMED" },
        { status: 409 },
      );
    }
    logServerError("monthly_report_recipient_delivery_failed");
    return Response.json(
      { ok: false, code: "MONTHLY_REPORT_RECIPIENT_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
