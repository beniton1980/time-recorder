import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { getSql } from "@/lib/db";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { logServerError } from "@/lib/safe-log";
import { calculatePayrollPreviewForStore } from "@/lib/payroll-preview-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
type RequestBody = { idToken?: unknown; storeId?: unknown; periodStart?: unknown; periodEnd?: unknown };

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !isoDatePattern.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export async function POST(request: Request) {
  let body: RequestBody;
  try { body = (await request.json()) as RequestBody; }
  catch { return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }

  if (typeof body.idToken !== "string" || typeof body.storeId !== "string" || !uuidPattern.test(body.storeId)
      || !validDate(body.periodStart) || !validDate(body.periodEnd) || body.periodStart > body.periodEnd) {
    return NextResponse.json({ ok: false, code: "INVALID_INPUT" }, { status: 400 });
  }

  const limited = await enforceRateLimit(request, { scope: "manager-payroll-save", limit: 10, windowSeconds: 300 }, body.idToken);
  if (limited) return limited;

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({ mode: "manager", lineIdentity: identity.sub, storeId: body.storeId });
    const preview = await calculatePayrollPreviewForStore(sql, body.storeId, body.periodStart, body.periodEnd);

    if (preview.summary.staffCount === 0) {
      return NextResponse.json({ ok: false, code: "PAYROLL_NOTHING_TO_SAVE" }, { status: 409 });
    }
    if (preview.summary.needsReviewCount > 0 || preview.staff.some((member) => member.status !== "CONFIRMED")) {
      return NextResponse.json({ ok: false, code: "PAYROLL_REVIEW_REQUIRED", needsReviewCount: preview.summary.needsReviewCount }, { status: 409 });
    }

    const calculationSpecVersion = preview.staff[0]?.calculationSpecVersion ?? "unknown";
    const settingsSnapshot = JSON.stringify({ settings: preview.settings, rates: preview.rates, context: preview.context });
    const itemsSnapshot = JSON.stringify(preview.staff.map((member) => ({
      staffId: member.staffId,
      legalName: member.legalName,
      hourlyRatesUsed: member.hourlyRatesUsed,
      minutes: member.minutes,
      components: member.components,
      grossPay: member.grossPay,
      calculationSpecVersion: member.calculationSpecVersion,
      sourceAttendanceSpecVersions: member.sourceAttendanceSpecVersions,
    })));

    const rows = await sql`
      WITH new_run AS (
        INSERT INTO payroll_runs (
          store_id, period_start, period_end, gross_pay_yen,
          calculation_spec_version, settings_snapshot, saved_by_line_user_id
        ) VALUES (
          ${body.storeId}::uuid, ${body.periodStart}::date, ${body.periodEnd}::date,
          ${preview.summary.grossPay}, ${calculationSpecVersion}, ${settingsSnapshot}::jsonb, ${identity.sub}
        )
        RETURNING id, saved_at
      ), new_items AS (
        INSERT INTO payroll_run_items (
          payroll_run_id, store_id, staff_id, legal_name_snapshot,
          hourly_rates_used, minutes_snapshot, components_snapshot,
          gross_pay_yen, calculation_spec_version, source_attendance_spec_versions
        )
        SELECT
          new_run.id,
          ${body.storeId}::uuid,
          (item->>'staffId')::uuid,
          item->>'legalName',
          item->'hourlyRatesUsed',
          item->'minutes',
          item->'components',
          (item->>'grossPay')::integer,
          item->>'calculationSpecVersion',
          item->'sourceAttendanceSpecVersions'
        FROM new_run
        CROSS JOIN jsonb_array_elements(${itemsSnapshot}::jsonb) AS item
        RETURNING id
      )
      SELECT new_run.id, new_run.saved_at, (SELECT COUNT(*)::int FROM new_items) AS item_count
      FROM new_run
    `;
    const saved = rows[0];
    if (!saved || Number(saved.item_count) !== preview.staff.length) throw new Error("PAYROLL_SNAPSHOT_ITEM_COUNT_MISMATCH");

    return NextResponse.json({
      ok: true,
      persisted: true,
      runId: saved.id,
      savedAt: saved.saved_at,
      period: preview.period,
      grossPay: preview.summary.grossPay,
      staffCount: preview.summary.staffCount,
      calculationSpecVersion,
    });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    logServerError("manager_payroll_save_failed");
    return NextResponse.json({ ok: false, code: "PAYROLL_SAVE_UNAVAILABLE" }, { status: 503 });
  }
}
