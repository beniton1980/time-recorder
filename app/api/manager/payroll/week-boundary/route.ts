import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { getSql } from "@/lib/db";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { logServerError } from "@/lib/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const supportedRules = new Set(["CALENDAR_DEFAULT", "EXPLICIT_WEEKDAY", "OTHER_REVIEW_REQUIRED"]);

type RequestBody = {
  idToken?: unknown;
  storeId?: unknown;
  action?: unknown;
  weekStartRule?: unknown;
  weekStartsOn?: unknown;
};

export async function POST(request: Request) {
  let body: RequestBody;
  try { body = (await request.json()) as RequestBody; }
  catch { return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }

  if (typeof body.idToken !== "string" || typeof body.storeId !== "string" || !uuidPattern.test(body.storeId)) {
    return NextResponse.json({ ok: false, code: "INVALID_INPUT" }, { status: 400 });
  }
  const limited = await enforceRateLimit(request, { scope: "manager-payroll-week-boundary", limit: 60, windowSeconds: 300 }, body.idToken);
  if (limited) return limited;

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({ mode: "manager", lineIdentity: identity.sub, storeId: body.storeId });
    const action = typeof body.action === "string" ? body.action : "load";

    if (action === "load") {
      const rows = await sql`
        SELECT week_start_rule, week_starts_on
        FROM payroll_store_settings
        WHERE store_id = ${body.storeId}::uuid
      `;
      const row = rows[0] ?? null;
      return NextResponse.json({
        ok: true,
        weekStartRule: row?.week_start_rule ?? "OTHER_REVIEW_REQUIRED",
        weekStartsOn: Number(row?.week_starts_on ?? 0),
      });
    }

    if (action === "save") {
      if (typeof body.weekStartRule !== "string" || !supportedRules.has(body.weekStartRule)) {
        return NextResponse.json({ ok: false, code: "INVALID_WEEK_START_RULE" }, { status: 400 });
      }
      let weekStartsOn = 0;
      if (body.weekStartRule === "EXPLICIT_WEEKDAY") {
        if (typeof body.weekStartsOn !== "number" || !Number.isInteger(body.weekStartsOn) || body.weekStartsOn < 0 || body.weekStartsOn > 6) {
          return NextResponse.json({ ok: false, code: "INVALID_WEEK_START_RULE" }, { status: 400 });
        }
        weekStartsOn = body.weekStartsOn;
      }
      const rows = await sql`
        INSERT INTO payroll_store_settings (store_id, week_start_rule, week_starts_on, updated_at)
        VALUES (${body.storeId}::uuid, ${body.weekStartRule}, ${weekStartsOn}, NOW())
        ON CONFLICT (store_id) DO UPDATE SET
          week_start_rule = EXCLUDED.week_start_rule,
          week_starts_on = EXCLUDED.week_starts_on,
          updated_at = NOW()
        RETURNING week_start_rule, week_starts_on
      `;
      return NextResponse.json({
        ok: true,
        weekStartRule: rows[0].week_start_rule,
        weekStartsOn: Number(rows[0].week_starts_on),
      });
    }

    return NextResponse.json({ ok: false, code: "UNKNOWN_ACTION" }, { status: 400 });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    logServerError("manager_payroll_week_boundary_failed");
    return NextResponse.json({ ok: false, code: "PAYROLL_WEEK_BOUNDARY_UNAVAILABLE" }, { status: 503 });
  }
}
