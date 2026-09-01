import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { enforceRateLimit } from "@/lib/api-security";
import { logServerError } from "@/lib/safe-log";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const closingRules = ["month_end", "day_15", "day_25"] as const;

type ClosingRule = (typeof closingRules)[number];
type SettingsRequest = {
  idToken?: unknown;
  storeId?: unknown;
  closingRule?: unknown;
  businessDayStartMinute?: unknown;
};

async function resolveManager(idToken: string, storeId: string) {
  const identity = await verifyLineIdToken(idToken);
  const sql = getSql({
    mode: "manager",
    lineIdentity: identity.sub,
    storeId,
  });

  const rows = await sql`
    SELECT s.id, s.name, s.closing_rule, s.business_day_start_minute,
      s.monthly_report_email
    FROM staff st
    JOIN stores s ON s.id = st.store_id
    LEFT JOIN staff_manager_access access
      ON access.staff_id = st.id AND access.store_id = st.store_id
    WHERE st.line_user_id = ${identity.sub}
      AND st.status = 'active'
      AND (st.role = 'MANAGER' OR access.status = 'active')
      AND s.status = 'active'
      AND st.store_id = ${storeId}::uuid
    ORDER BY st.created_at ASC
    LIMIT 1
  `;

  return { sql, store: rows[0] ?? null };
}

export async function POST(request: Request) {
  let body: SettingsRequest;
  try {
    body = (await request.json()) as SettingsRequest;
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 });
  }

  if (typeof body.idToken !== "string" || body.idToken.length === 0) {
    return NextResponse.json({ ok: false, code: "ID_TOKEN_REQUIRED" }, { status: 400 });
  }
  if (typeof body.storeId !== "string" || !uuidPattern.test(body.storeId)) {
    return NextResponse.json({ ok: false, code: "INVALID_STORE_ID" }, { status: 400 });
  }

  const limited = await enforceRateLimit(
    request,
    { scope: "manager-store-settings", limit: 60, windowSeconds: 300 },
    body.idToken,
  );
  if (limited) return limited;

  try {
    const { store } = await resolveManager(body.idToken, body.storeId);
    if (!store) {
      return NextResponse.json({ ok: false, code: "MANAGER_ACCESS_REQUIRED" }, { status: 403 });
    }

    return NextResponse.json({ ok: true, store });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    logServerError("manager_store_settings_load_failed");
    return NextResponse.json({ ok: false, code: "STORE_SETTINGS_UNAVAILABLE" }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  let body: SettingsRequest;
  try {
    body = (await request.json()) as SettingsRequest;
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 });
  }

  if (typeof body.idToken !== "string" || body.idToken.length === 0) {
    return NextResponse.json({ ok: false, code: "ID_TOKEN_REQUIRED" }, { status: 400 });
  }
  if (typeof body.storeId !== "string" || !uuidPattern.test(body.storeId)) {
    return NextResponse.json({ ok: false, code: "INVALID_STORE_ID" }, { status: 400 });
  }
  if (
    typeof body.closingRule !== "string" ||
    !closingRules.includes(body.closingRule as ClosingRule)
  ) {
    return NextResponse.json({ ok: false, code: "INVALID_CLOSING_RULE" }, { status: 400 });
  }
  if (
    typeof body.businessDayStartMinute !== "number" ||
    !Number.isInteger(body.businessDayStartMinute) ||
    body.businessDayStartMinute < 0 ||
    body.businessDayStartMinute >= 1440
  ) {
    return NextResponse.json({ ok: false, code: "INVALID_BUSINESS_DAY_START" }, { status: 400 });
  }

  const limited = await enforceRateLimit(
    request,
    { scope: "manager-store-settings-update", limit: 20, windowSeconds: 300 },
    body.idToken,
  );
  if (limited) return limited;

  try {
    const { sql, store } = await resolveManager(body.idToken, body.storeId);
    if (!store) {
      return NextResponse.json({ ok: false, code: "MANAGER_ACCESS_REQUIRED" }, { status: 403 });
    }

    const rows = await sql`
      UPDATE stores
      SET closing_rule = ${body.closingRule},
          business_day_start_minute = ${body.businessDayStartMinute}
      WHERE id = ${body.storeId}::uuid
      RETURNING id, name, closing_rule, business_day_start_minute, monthly_report_email
    `;

    return NextResponse.json({ ok: true, store: rows[0] });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    logServerError("manager_store_settings_update_failed");
    return NextResponse.json({ ok: false, code: "STORE_SETTINGS_UPDATE_FAILED" }, { status: 503 });
  }
}
