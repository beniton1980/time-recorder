import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { getSql } from "@/lib/db";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { logServerError } from "@/lib/safe-log";
import { comparePayrollSnapshots } from "@/lib/payroll-snapshot-diff.mjs";

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
        SELECT r.id, r.period_start::text, r.period_end::text, r.gross_pay_yen,
               r.calculation_spec_version, r.saved_at,
               1 + (SELECT COUNT(*)::int FROM payroll_runs older
                    WHERE older.store_id = r.store_id
                      AND older.period_start = r.period_start AND older.period_end = r.period_end
                      AND (older.saved_at, older.id) < (r.saved_at, r.id)) AS version_number,
               (SELECT COUNT(*)::int FROM payroll_runs same_period
                WHERE same_period.store_id = r.store_id
                  AND same_period.period_start = r.period_start AND same_period.period_end = r.period_end) AS version_count,
               NOT EXISTS (SELECT 1 FROM payroll_runs newer
                           WHERE newer.store_id = r.store_id
                             AND newer.period_start = r.period_start AND newer.period_end = r.period_end
                             AND (newer.saved_at, newer.id) > (r.saved_at, r.id)) AS is_latest
        FROM payroll_runs r
        WHERE r.store_id = ${body.storeId}::uuid AND r.id = ${body.runId}::uuid
        LIMIT 1
      `;
      if (!runs[0]) return NextResponse.json({ ok: false, code: "PAYROLL_RUN_NOT_FOUND" }, { status: 404 });
      const items = await sql`
        SELECT staff_id, legal_name_snapshot, hourly_rates_used, minutes_snapshot,
               components_snapshot, commuting_allowance_snapshot, gross_pay_yen, calculation_spec_version,
               source_attendance_spec_versions
        FROM payroll_run_items
        WHERE store_id = ${body.storeId}::uuid AND payroll_run_id = ${body.runId}::uuid
        ORDER BY legal_name_snapshot, staff_id
      `;
      const previousRuns = await sql`
        SELECT id, period_start::text, period_end::text, gross_pay_yen,
               calculation_spec_version, saved_at,
               (SELECT COUNT(*)::int FROM payroll_runs older
                WHERE older.store_id = previous.store_id
                  AND older.period_start = previous.period_start AND older.period_end = previous.period_end
                  AND (older.saved_at, older.id) <= (previous.saved_at, previous.id)) AS version_number
        FROM payroll_runs previous
        WHERE previous.store_id = ${body.storeId}::uuid
          AND previous.period_start = ${runs[0].period_start}::date
          AND previous.period_end = ${runs[0].period_end}::date
          AND (previous.saved_at, previous.id) < (${runs[0].saved_at}::timestamptz, ${body.runId}::uuid)
        ORDER BY previous.saved_at DESC, previous.id DESC
        LIMIT 1
      `;
      let comparison = null;
      if (previousRuns[0]) {
        const previousItems = await sql`
          SELECT staff_id, legal_name_snapshot, hourly_rates_used, minutes_snapshot,
                 components_snapshot, commuting_allowance_snapshot, gross_pay_yen, calculation_spec_version,
                 source_attendance_spec_versions
          FROM payroll_run_items
          WHERE store_id = ${body.storeId}::uuid AND payroll_run_id = ${previousRuns[0].id}::uuid
          ORDER BY legal_name_snapshot, staff_id
        `;
        comparison = { previousRun: previousRuns[0], ...comparePayrollSnapshots({ previousRun: previousRuns[0], previousItems, currentRun: runs[0], currentItems: items }) };
      }
      return NextResponse.json({ ok: true, run: runs[0], items, comparison });
    }

    const runs = await sql`
      WITH grouped AS (
        SELECT r.id, r.period_start, r.period_end, r.gross_pay_yen,
               r.calculation_spec_version, r.saved_at, COUNT(i.id)::int AS staff_count
        FROM payroll_runs r
        LEFT JOIN payroll_run_items i
          ON i.store_id = r.store_id AND i.payroll_run_id = r.id
        WHERE r.store_id = ${body.storeId}::uuid
        GROUP BY r.id
      ), versioned AS (
        SELECT grouped.*,
               ROW_NUMBER() OVER (PARTITION BY period_start, period_end ORDER BY saved_at, id)::int AS version_number,
               COUNT(*) OVER (PARTITION BY period_start, period_end)::int AS version_count,
               ROW_NUMBER() OVER (PARTITION BY period_start, period_end ORDER BY saved_at DESC, id DESC) = 1 AS is_latest
        FROM grouped
      )
      SELECT id, period_start::text, period_end::text, gross_pay_yen,
             calculation_spec_version, saved_at, staff_count,
             version_number, version_count, is_latest
      FROM versioned
      ORDER BY period_end DESC, period_start DESC, saved_at DESC, id DESC
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
