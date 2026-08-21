import { createHash } from "node:crypto";
import { enforceRateLimit } from "@/lib/api-security";
import { getSql } from "@/lib/db";
import { MONTHLY_REPORT_CONSENT_VERSION } from "@/lib/monthly-report-recipient";
import { logServerError } from "@/lib/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { storeId?: unknown; token?: unknown; consent?: unknown };

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
    return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 });
  }

  if (
    typeof body.storeId !== "string"
    || !uuidPattern.test(body.storeId)
    || typeof body.token !== "string"
    || body.token.length < 32
    || body.token.length > 256
    || body.consent !== true
  ) {
    return Response.json(
      { ok: false, code: "MONTHLY_RECIPIENT_VERIFICATION_INVALID" },
      { status: 400 },
    );
  }

  const limited = await enforceRateLimit(
    request,
    { scope: "monthly-recipient-verification", limit: 10, windowSeconds: 600 },
    body.token,
  );
  if (limited) return limited;

  try {
    const hash = tokenHash(body.token);
    const sql = getSql({
      mode: "monthly_email_verification",
      storeId: body.storeId,
    });
    const rows = await sql`
      SELECT public.confirm_monthly_report_recipient(
        ${body.storeId}::uuid,
        ${hash},
        ${MONTHLY_REPORT_CONSENT_VERSION}
      ) AS confirmed
    `;
    if (rows[0]?.confirmed !== true) {
      return Response.json(
        { ok: false, code: "MONTHLY_RECIPIENT_VERIFICATION_INVALID" },
        { status: 400 },
      );
    }
    return Response.json({ ok: true });
  } catch {
    logServerError("monthly_report_recipient_verification_failed");
    return Response.json(
      { ok: false, code: "MONTHLY_RECIPIENT_VERIFICATION_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
