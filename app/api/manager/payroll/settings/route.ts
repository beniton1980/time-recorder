import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { getSql } from "@/lib/db";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { logServerError } from "@/lib/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const isoMonthPattern = /^\d{4}-\d{2}$/;
const supportedWorkTimeSystems = new Set(["STANDARD_40H", "SPECIAL_44H", "OTHER_REVIEW_REQUIRED"]);
const supportedOvertimeMonthRules = new Set(["PAY_PERIOD", "CALENDAR_MONTH", "OTHER_REVIEW_REQUIRED"]);
const supportedStatutoryHolidayRules = new Set(["FIXED_WEEKDAY", "MANUAL_DATES", "OTHER_REVIEW_REQUIRED"]);

type RequestBody = {
  idToken?: unknown;
  storeId?: unknown;
  action?: unknown;
  workTimeSystem?: unknown;
  overtimeMonthRule?: unknown;
  statutoryHolidayRule?: unknown;
  statutoryHolidayWeekday?: unknown;
  holidayDate?: unknown;
  holidayMonth?: unknown;
  holidayDates?: unknown;
  staffId?: unknown;
  hourlyRateYen?: unknown;
  effectiveFrom?: unknown;
  initialCompensationTerms?: unknown;
};

type ValidCompensationBody = RequestBody & {
  staffId: string;
  hourlyRateYen: number;
  effectiveFrom: string;
};

type InitialCompensationInput = {
  staffId: string;
  hourlyRateYen: number;
  effectiveFrom: string;
};

type CompensationTermRow = {
  id: string;
  staff_id: string;
  hourly_rate_yen: number;
  effective_from: string;
  effective_to: string | null;
  created_at?: string;
};

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !isoDatePattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validMonth(value: unknown): value is string {
  if (typeof value !== "string" || !isoMonthPattern.test(value)) return false;
  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  return Number.isInteger(year) && month >= 1 && month <= 12;
}

function validCompensationInput(body: RequestBody): body is ValidCompensationBody {
  return typeof body.staffId === "string"
    && uuidPattern.test(body.staffId)
    && typeof body.hourlyRateYen === "number"
    && Number.isInteger(body.hourlyRateYen)
    && body.hourlyRateYen > 0
    && validDate(body.effectiveFrom);
}

function parseInitialCompensationTerms(value: unknown): InitialCompensationInput[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) return null;
  const terms: InitialCompensationInput[] = [];
  const staffIds = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.staffId !== "string" || !uuidPattern.test(candidate.staffId)) return null;
    if (staffIds.has(candidate.staffId)) return null;
    if (typeof candidate.hourlyRateYen !== "number" || !Number.isInteger(candidate.hourlyRateYen) || candidate.hourlyRateYen <= 0) return null;
    if (!validDate(candidate.effectiveFrom)) return null;
    staffIds.add(candidate.staffId);
    terms.push({ staffId: candidate.staffId, hourlyRateYen: candidate.hourlyRateYen, effectiveFrom: candidate.effectiveFrom });
  }
  return terms;
}

function validStoreSettings(body: RequestBody) {
  if (typeof body.workTimeSystem !== "string" || !supportedWorkTimeSystems.has(body.workTimeSystem)) return false;
  if (typeof body.overtimeMonthRule !== "string" || !supportedOvertimeMonthRules.has(body.overtimeMonthRule)) return false;
  if (typeof body.statutoryHolidayRule !== "string" || !supportedStatutoryHolidayRules.has(body.statutoryHolidayRule)) return false;
  if (body.statutoryHolidayRule === "FIXED_WEEKDAY") {
    return typeof body.statutoryHolidayWeekday === "number"
      && Number.isInteger(body.statutoryHolidayWeekday)
      && body.statutoryHolidayWeekday >= 0
      && body.statutoryHolidayWeekday <= 6;
  }
  return body.statutoryHolidayWeekday == null;
}

function postgresCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
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
      const [settingsRows, staffRows, termRows, holidayRows] = await Promise.all([
        sql`
          SELECT
            store_id,
            work_time_system,
            week_starts_on,
            overtime_month_rule,
            statutory_holiday_rule,
            statutory_holiday_weekday,
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
        sql`
          SELECT holiday_date::text AS holiday_date
          FROM payroll_statutory_holidays
          WHERE store_id = ${storeId}::uuid
          ORDER BY holiday_date DESC
          LIMIT 120
        `,
      ]);

      return NextResponse.json({
        ok: true,
        settings: settingsRows[0] ?? null,
        staff: staffRows,
        compensationTerms: termRows,
        statutoryHolidayDates: holidayRows.map((row) => row.holiday_date),
      });
    }

    if (action === "saveStoreSettings") {
      if (!validStoreSettings(body)) {
        return NextResponse.json({ ok: false, code: "INVALID_PAYROLL_STORE_SETTINGS" }, { status: 400 });
      }
      const weekday = body.statutoryHolidayRule === "FIXED_WEEKDAY" ? body.statutoryHolidayWeekday : null;
      const rows = await sql`
        INSERT INTO payroll_store_settings (
          store_id,
          work_time_system,
          overtime_month_rule,
          statutory_holiday_rule,
          statutory_holiday_weekday,
          updated_at
        )
        VALUES (
          ${storeId}::uuid,
          ${body.workTimeSystem},
          ${body.overtimeMonthRule},
          ${body.statutoryHolidayRule},
          ${weekday},
          NOW()
        )
        ON CONFLICT (store_id) DO UPDATE
        SET work_time_system = EXCLUDED.work_time_system,
            overtime_month_rule = EXCLUDED.overtime_month_rule,
            statutory_holiday_rule = EXCLUDED.statutory_holiday_rule,
            statutory_holiday_weekday = EXCLUDED.statutory_holiday_weekday,
            updated_at = NOW()
        RETURNING store_id, work_time_system, week_starts_on,
          overtime_month_rule, statutory_holiday_rule, statutory_holiday_weekday,
          overtime_premium_rate::float8 AS overtime_premium_rate,
          high_overtime_premium_rate::float8 AS high_overtime_premium_rate,
          statutory_holiday_premium_rate::float8 AS statutory_holiday_premium_rate,
          late_night_premium_rate::float8 AS late_night_premium_rate,
          rounding_mode
      `;
      return NextResponse.json({ ok: true, settings: rows[0] });
    }

    if (action === "saveStatutoryHolidayMonth") {
      if (!validMonth(body.holidayMonth) || !Array.isArray(body.holidayDates) || body.holidayDates.length > 31) {
        return NextResponse.json({ ok: false, code: "INVALID_STATUTORY_HOLIDAY_DATE" }, { status: 400 });
      }
      const holidayDates = [...new Set(body.holidayDates)];
      if (!holidayDates.every((date) => validDate(date) && date.startsWith(`${body.holidayMonth}-`))) {
        return NextResponse.json({ ok: false, code: "INVALID_STATUTORY_HOLIDAY_DATE" }, { status: 400 });
      }
      const monthStart = `${body.holidayMonth}-01`;
      const [yearText, monthText] = body.holidayMonth.split("-");
      const nextMonth = new Date(Date.UTC(Number(yearText), Number(monthText), 1)).toISOString().slice(0, 10);
      const statements = [
        sql`DELETE FROM payroll_statutory_holidays WHERE store_id = ${storeId}::uuid AND holiday_date >= ${monthStart}::date AND holiday_date < ${nextMonth}::date`,
        ...holidayDates.map((holidayDate) => sql`
          INSERT INTO payroll_statutory_holidays (store_id, holiday_date, created_by_line_user_id)
          VALUES (${storeId}::uuid, ${holidayDate}::date, ${identity.sub})
          ON CONFLICT (store_id, holiday_date) DO NOTHING
        `),
      ];
      await sql.transaction(() => statements);
      return NextResponse.json({ ok: true, statutoryHolidayDates: holidayDates.sort() });
    }

    if (action === "addStatutoryHolidayDate") {
      if (!validDate(body.holidayDate)) {
        return NextResponse.json({ ok: false, code: "INVALID_STATUTORY_HOLIDAY_DATE" }, { status: 400 });
      }
      await sql`
        INSERT INTO payroll_statutory_holidays (store_id, holiday_date, created_by_line_user_id)
        VALUES (${storeId}::uuid, ${body.holidayDate}::date, ${identity.sub})
        ON CONFLICT (store_id, holiday_date) DO NOTHING
      `;
      return NextResponse.json({ ok: true });
    }

    if (action === "removeStatutoryHolidayDate") {
      if (!validDate(body.holidayDate)) {
        return NextResponse.json({ ok: false, code: "INVALID_STATUTORY_HOLIDAY_DATE" }, { status: 400 });
      }
      await sql`
        DELETE FROM payroll_statutory_holidays
        WHERE store_id = ${storeId}::uuid
          AND holiday_date = ${body.holidayDate}::date
      `;
      return NextResponse.json({ ok: true });
    }

    if (action === "saveInitialCompensationTerms") {
      const terms = parseInitialCompensationTerms(body.initialCompensationTerms);
      if (!terms) {
        return NextResponse.json({ ok: false, code: "INVALID_COMPENSATION_TERM" }, { status: 400 });
      }
      const staffIds = terms.map((term) => term.staffId);
      const existing = await sql`
        SELECT staff_id
        FROM payroll_compensation_terms
        WHERE store_id = ${storeId}::uuid
          AND staff_id = ANY(${staffIds}::uuid[])
        LIMIT 1
      `;
      if (existing.length > 0) {
        return NextResponse.json({ ok: false, code: "COMPENSATION_HISTORY_EXISTS" }, { status: 409 });
      }
      const statements = terms.map((term) => sql`
        INSERT INTO payroll_compensation_terms (
          store_id, staff_id, hourly_rate_yen, effective_from, created_by_line_user_id
        )
        VALUES (
          ${storeId}::uuid,
          ${term.staffId}::uuid,
          ${term.hourlyRateYen},
          ${term.effectiveFrom}::date,
          ${identity.sub}
        )
        RETURNING id, staff_id, hourly_rate_yen, effective_from::text, effective_to::text, created_at
      `);
      const inserted = await sql.transaction(() => statements);
      return NextResponse.json({ ok: true, compensationTerms: inserted.flat() });
    }

    if (action === "createInitialCompensationTerm") {
      if (!validCompensationInput(body)) {
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
          ${body.hourlyRateYen},
          ${body.effectiveFrom}::date,
          ${identity.sub}
        )
        RETURNING id, staff_id, hourly_rate_yen, effective_from::text, effective_to::text, created_at
      `;
      return NextResponse.json({ ok: true, compensationTerm: rows[0] });
    }

    if (action === "reviseCompensationTerm") {
      if (!validCompensationInput(body)) {
        return NextResponse.json({ ok: false, code: "INVALID_COMPENSATION_TERM" }, { status: 400 });
      }

      const openRows = await sql`
        SELECT id, staff_id, hourly_rate_yen, effective_from::text, effective_to::text
        FROM payroll_compensation_terms
        WHERE store_id = ${storeId}::uuid
          AND staff_id = ${body.staffId}::uuid
          AND effective_to IS NULL
        ORDER BY effective_from DESC
      ` as CompensationTermRow[];

      if (openRows.length !== 1) {
        return NextResponse.json({ ok: false, code: "COMPENSATION_CURRENT_TERM_REQUIRED" }, { status: 409 });
      }

      const current = openRows[0];
      if (body.effectiveFrom <= current.effective_from) {
        return NextResponse.json({ ok: false, code: "COMPENSATION_REVISION_DATE_INVALID" }, { status: 409 });
      }

      try {
        const [, insertedRows] = await sql.transaction((tx) => [
          tx`
            UPDATE payroll_compensation_terms
            SET effective_to = ${body.effectiveFrom}::date - 1
            WHERE id = ${current.id}::uuid
              AND store_id = ${storeId}::uuid
              AND staff_id = ${body.staffId}::uuid
              AND effective_to IS NULL
          `,
          tx`
            INSERT INTO payroll_compensation_terms (
              store_id, staff_id, hourly_rate_yen, effective_from, created_by_line_user_id
            )
            VALUES (
              ${storeId}::uuid,
              ${body.staffId}::uuid,
              ${body.hourlyRateYen},
              ${body.effectiveFrom}::date,
              ${identity.sub}
            )
            RETURNING id, staff_id, hourly_rate_yen, effective_from::text, effective_to::text, created_at
          `,
        ]);
        return NextResponse.json({ ok: true, compensationTerm: insertedRows[0] });
      } catch (error) {
        if (postgresCode(error) === "23P01") {
          return NextResponse.json({ ok: false, code: "COMPENSATION_PERIOD_OVERLAP" }, { status: 409 });
        }
        throw error;
      }
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