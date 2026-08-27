import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { getSql } from "@/lib/db";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { payrollPeriodForMonth } from "@/lib/payroll-default-period.mjs";
import { logServerError } from "@/lib/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const payrollMonthPattern = /^\d{4}-\d{2}$/;

type RequestBody = { idToken?: unknown; storeId?: unknown; payrollMonth?: unknown };

function todayInTimezone(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function POST(request: Request) {
  let body: RequestBody;
  try { body = (await request.json()) as RequestBody; }
  catch { return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }

  if (typeof body.idToken !== "string" || typeof body.storeId !== "string" || !uuidPattern.test(body.storeId)) {
    return NextResponse.json({ ok: false, code: "INVALID_INPUT" }, { status: 400 });
  }
  if (body.payrollMonth != null && (typeof body.payrollMonth !== "string" || !payrollMonthPattern.test(body.payrollMonth))) {
    return NextResponse.json({ ok: false, code: "INVALID_PAYROLL_MONTH" }, { status: 400 });
  }

  const limited = await enforceRateLimit(request, { scope: "manager-payroll-default-period", limit: 60, windowSeconds: 300 }, body.idToken);
  if (limited) return limited;

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({ mode: "manager", lineIdentity: identity.sub, storeId: body.storeId });
    const rows = await sql`
      SELECT closing_rule, timezone
      FROM stores
      WHERE id = ${body.storeId}::uuid
        AND status = 'active'
    `;
    if (rows.length !== 1) return NextResponse.json({ ok: false, code: "STORE_NOT_FOUND" }, { status: 404 });
    const today = todayInTimezone(String(rows[0].timezone));
    const closingRule = String(rows[0].closing_rule);
    const payrollMonth = typeof body.payrollMonth === "string" ? body.payrollMonth : today.slice(0, 7);
    const period = payrollPeriodForMonth(closingRule, payrollMonth);
    return NextResponse.json({ ok: true, today, closingRule, payrollMonth, period });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    logServerError("manager_payroll_default_period_failed");
    return NextResponse.json({ ok: false, code: "PAYROLL_DEFAULT_PERIOD_UNAVAILABLE" }, { status: 503 });
  }
}
