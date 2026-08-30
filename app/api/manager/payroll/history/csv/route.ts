import { enforceRateLimit } from "@/lib/api-security";
import { getSql } from "@/lib/db";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { createPayrollSnapshotCsv } from "@/lib/payroll-snapshot-csv.mjs";
import { logServerError } from "@/lib/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RequestBody = { idToken?: unknown; storeId?: unknown; runId?: unknown };

function filenamePart(value: unknown) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, "_").slice(0, 80) || "ONOGAMI";
}

export async function POST(request: Request) {
  let body: RequestBody;
  try { body = (await request.json()) as RequestBody; }
  catch { return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  if (typeof body.idToken !== "string" || typeof body.storeId !== "string" || !uuidPattern.test(body.storeId)
      || typeof body.runId !== "string" || !uuidPattern.test(body.runId)) {
    return Response.json({ ok: false, code: "INVALID_INPUT" }, { status: 400 });
  }
  const limited = await enforceRateLimit(request, { scope: "manager-payroll-csv", limit: 30, windowSeconds: 300 }, body.idToken);
  if (limited) return limited;

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({ mode: "manager", lineIdentity: identity.sub, storeId: body.storeId });
    const runs = await sql`
      SELECT r.id, r.period_start::text, r.period_end::text, r.gross_pay_yen,
             r.calculation_spec_version, r.saved_at, s.name AS store_name,
             1 + (SELECT COUNT(*)::int FROM payroll_runs older
                  WHERE older.store_id = r.store_id
                    AND older.period_start = r.period_start AND older.period_end = r.period_end
                    AND (older.saved_at, older.id) < (r.saved_at, r.id)) AS version_number,
             NOT EXISTS (SELECT 1 FROM payroll_runs newer
                         WHERE newer.store_id = r.store_id
                           AND newer.period_start = r.period_start AND newer.period_end = r.period_end
                           AND (newer.saved_at, newer.id) > (r.saved_at, r.id)) AS is_latest,
             (SELECT COUNT(*)::int FROM payroll_run_items item_count
              WHERE item_count.store_id = r.store_id AND item_count.payroll_run_id = r.id) AS staff_count,
             (SELECT COALESCE(SUM(item_total.gross_pay_yen), 0)::int FROM payroll_run_items item_total
              WHERE item_total.store_id = r.store_id AND item_total.payroll_run_id = r.id) AS items_gross_pay_yen
      FROM payroll_runs r
      JOIN stores s ON s.id = r.store_id
      WHERE r.store_id = ${body.storeId}::uuid AND r.id = ${body.runId}::uuid
      LIMIT 1
    `;
    const run = runs[0];
    if (!run) return Response.json({ ok: false, code: "PAYROLL_RUN_NOT_FOUND" }, { status: 404 });
    if (!run.is_latest) return Response.json({ ok: false, code: "PAYROLL_RUN_NOT_LATEST" }, { status: 409 });
    if (Number(run.staff_count) < 1 || Number(run.items_gross_pay_yen) !== Number(run.gross_pay_yen)) {
      return Response.json({ ok: false, code: "PAYROLL_SNAPSHOT_INCOMPLETE" }, { status: 409 });
    }
    const items = await sql`
      SELECT legal_name_snapshot, hourly_rates_used, minutes_snapshot, components_snapshot,
             gross_pay_yen, calculation_spec_version, source_attendance_spec_versions
      FROM payroll_run_items
      WHERE store_id = ${body.storeId}::uuid AND payroll_run_id = ${body.runId}::uuid
      ORDER BY legal_name_snapshot, staff_id
    `;
    if (items.length !== Number(run.staff_count)) {
      return Response.json({ ok: false, code: "PAYROLL_SNAPSHOT_INCOMPLETE" }, { status: 409 });
    }
    const csv = createPayrollSnapshotCsv({ storeName: String(run.store_name), run: run as never, items: items as never });
    const safeStoreName = filenamePart(run.store_name);
    const japaneseName = encodeURIComponent(`${safeStoreName}-控除前給与集計-${run.period_start}_${run.period_end}-第${run.version_number}版.csv`);
    return new Response(csv, { headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="onogami-payroll-${run.period_start}-${run.period_end}-v${run.version_number}.csv"; filename*=UTF-8''${japaneseName}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    }});
  } catch (error) {
    if (error instanceof LineTokenVerificationError) return Response.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    logServerError("manager_payroll_csv_failed");
    return Response.json({ ok: false, code: "PAYROLL_CSV_UNAVAILABLE" }, { status: 503 });
  }
}
