import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { getSql } from "@/lib/db";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { logServerError } from "@/lib/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RequestBody = { idToken?: unknown; storeId?: unknown; runId?: unknown };

export async function POST(request: Request) {
  let body: RequestBody;
  try { body = (await request.json()) as RequestBody; }
  catch { return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }

  if (typeof body.idToken !== "string" || typeof body.storeId !== "string" || !uuidPattern.test(body.storeId)
      || (body.runId != null && (typeof body.runId !== "string" || !uuidPattern.test(body.runId)))) {
    return NextResponse.json({ ok: false, code: "INVALID_INPUT" }, { status: 400 });
  }

  const limited = await enforceRateLimit(request, { scope: "manager-payroll-history", limit: 60, windowSeconds: 300 }, body.idToken);
  if (limited) return limited;

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({ mode: "manager", lineIdentity: identity.sub, storeId: body.storeId });

    if (typeof body.runId === "string") {
      const runs = await sql`
        SELECT id, period_start::text, period_end::text, gross_pay_yen,
               calculation_spec_version, saved_at
        FROM payroll_runs
        WHERE store_id = ${body.storeId}::uuid AND id = ${body.runId}::uuid
        LIMIT 1
      `;
      if (!runs[0]) return NextResponse.json({ ok: false, code: "PAYROLL_RUN_NOT_FOUND" }, { status: 404 });
      const items = await sql`
        SELECT staff_id, legal_name_snapshot, hourly_rates_used, minutes_snapshot,
               components_snapshot, gross_pay_yen, calculation_spec_version,
               source_attendance_spec_versions
        FROM payroll_run_items
        WHERE store_id = ${body.storeId}::uuid AND payroll_run_id = ${body.runId}::uuid
        ORDER BY legal_name_snapshot, staff_id
      `;
      return NextResponse.json({ ok: true, run: runs[0], items });
    }

    const runs = await sql`
      SELECT r.id, r.period_start::text, r.period_end::text, r.gross_pay_yen,
             r.calculation_spec_version, r.saved_at, COUNT(i.id)::int AS staff_count
      FROM payroll_runs r
      LEFT JOIN payroll_run_items i
        ON i.store_id = r.store_id AND i.payroll_run_id = r.id
      WHERE r.store_id = ${body.storeId}::uuid
      GROUP BY r.id
      ORDER BY r.period_end DESC, r.saved_at DESC
      LIMIT 24
    `;
    return NextResponse.json({ ok: true, runs });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    logServerError("manager_payroll_history_failed");
    return NextResponse.json({ ok: false, code: "PAYROLL_HISTORY_UNAVAILABLE" }, { status: 503 });
  }
}
