import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { getSql } from "@/lib/db";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { logServerError } from "@/lib/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const supportedWorkTimeSystems = new Set(["STANDARD_40H", "SPECIAL_44H", "OTHER_REVIEW_REQUIRED"]);

type RequestBody = {
  idToken?: unknown;
  storeId?: unknown;
  action?: unknown;
  workTimeSystem?: unknown;
  staffId?: unknown;
  hourlyRateYen?: unknown;
  effectiveFrom?: unknown;
};

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !isoDatePattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

async function authenticate(request: Request, body: RequestBody) {
  if (typeof body.idToken !== "string" || typeof body.storeId !== "string" || !uuidPattern.test(body.storeId)) {
    return { error: NextResponse.json({ ok: false, code: "INVALID_INPUT" }, { status: 400 }) } as const;
  }
  const limited = await enforceRateLimit(request, { scope: "manager-payroll-settings", limit: 60, windowSeconds: 300 }, body.idToken);
  if (limited) return { error: limited } as const;
  const identity = await verifyLineIdToken(body.idToken);
  const sql = getSql({ mode: "manager", lineIdentity: identity.sub, storeId: body.storeId });
  return { identity, sql, storeId: body.storeId } as const;
}

export async function POST(request: Request) {
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 });
  }

  try {
    const auth = await authenticate(request, body);
    if ("error" in auth) return auth.error;
    const { identity, sql, storeId } = auth;
    const action = typeof body.action === "string" ? body.action : "load";

    if (action === "load") {
      const [settingsRows, staffRows, termRows] = await Promise.all([
        sql`
          SELECT
            store_id,
            work_time_system,
            week_starts_on,
            overtime_premium_rate::float8 AS overtime_premium_rate,
            high_overtime_premium_rate::float8 AS high_overtime_premium_rate,
            statutory_holiday_premium_rate::float8 AS statutory_holiday_premium_rate,
            late_night_premium_rate::float8 AS late_night_premium_rate,
            rounding_mode
          FROM payroll_store_settings
          WHERE store_id = ${storeId}::uuid
        `,
        sql`
          SELECT id AS staff_id, legal_name, status
          FROM staff
          WHERE store_id = ${storeId}::uuid
            AND status IN ('active', 'inactive')
          ORDER BY status ASC, created_at ASC
        `,
        sql`
          SELECT id, staff_id, hourly_rate_yen, effective_from::text, effective_to::text, created_at
          FROM payroll_compensation_terms
          WHERE store_id = ${storeId}::uuid
          ORDER BY staff_id, effective_from DESC, created_at DESC
        `,
      ]);

      return NextResponse.json({
        ok: true,
        settings: settingsRows[0] ?? null,
        staff: staffRows,
        compensationTerms: termRows,
      });
    }

    if (action === "saveStoreSettings") {
      if (typeof body.workTimeSystem !== "string" || !supportedWorkTimeSystems.has(body.workTimeSystem)) {
        return NextResponse.json({ ok: false, code: "INVALID_WORK_TIME_SYSTEM" }, { status: 400 });
      }
      const rows = await sql`
        INSERT INTO payroll_store_settings (store_id, work_time_system, updated_at)
        VALUES (${storeId}::uuid, ${body.workTimeSystem}, NOW())
        ON CONFLICT (store_id) DO UPDATE
        SET work_time_system = EXCLUDED.work_time_system,
            updated_at = NOW()
        RETURNING store_id, work_time_system, week_starts_on,
          overtime_premium_rate::float8 AS overtime_premium_rate,
          high_overtime_premium_rate::float8 AS high_overtime_premium_rate,
          statutory_holiday_premium_rate::float8 AS statutory_holiday_premium_rate,
          late_night_premium_rate::float8 AS late_night_premium_rate,
          rounding_mode
      `;
      return NextResponse.json({ ok: true, settings: rows[0] });
    }

    if (action === "createInitialCompensationTerm") {
      if (
        typeof body.staffId !== "string" || !uuidPattern.test(body.staffId)
        || !Number.isInteger(body.hourlyRateYen) || Number(body.hourlyRateYen) <= 0
        || !validDate(body.effectiveFrom)
      ) {
        return NextResponse.json({ ok: false, code: "INVALID_COMPENSATION_TERM" }, { status: 400 });
      }

      const existing = await sql`
        SELECT 1
        FROM payroll_compensation_terms
        WHERE store_id = ${storeId}::uuid
          AND staff_id = ${body.staffId}::uuid
        LIMIT 1
      `;
      if (existing.length > 0) {
        return NextResponse.json({ ok: false, code: "COMPENSATION_HISTORY_EXISTS" }, { status: 409 });
      }

      const rows = await sql`
        INSERT INTO payroll_compensation_terms (
          store_id, staff_id, hourly_rate_yen, effective_from, created_by_line_user_id
        )
        VALUES (
          ${storeId}::uuid,
          ${body.staffId}::uuid,
          ${Number(body.hourlyRateYen)},
          ${body.effectiveFrom}::date,
          ${identity.sub}
        )
        RETURNING id, staff_id, hourly_rate_yen, effective_from::text, effective_to::text, created_at
      `;
      return NextResponse.json({ ok: true, compensationTerm: rows[0] });
    }

    return NextResponse.json({ ok: false, code: "UNSUPPORTED_ACTION" }, { status: 400 });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    logServerError("manager_payroll_settings_failed");
    return NextResponse.json({ ok: false, code: "PAYROLL_SETTINGS_UNAVAILABLE" }, { status: 503 });
  }
}
