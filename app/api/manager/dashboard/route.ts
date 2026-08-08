import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DashboardRequest = { idToken?: unknown; businessDate?: unknown };

export async function POST(request: Request) {
  let body: DashboardRequest;
  try {
    body = (await request.json()) as DashboardRequest;
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 });
  }

  if (typeof body.idToken !== "string" || body.idToken.length === 0) {
    return NextResponse.json({ ok: false, code: "ID_TOKEN_REQUIRED" }, { status: 400 });
  }

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql();

    const managers = await sql`
      SELECT st.id AS staff_id, st.legal_name, s.id AS store_id, s.name AS store_name
      FROM staff st
      JOIN stores s ON s.id = st.store_id
      WHERE st.line_user_id = ${identity.sub}
        AND st.status = 'active'
        AND st.role = 'MANAGER'
        AND s.status = 'active'
      ORDER BY st.created_at ASC
      LIMIT 1
    `;

    if (managers.length === 0) {
      return NextResponse.json({ ok: false, code: "MANAGER_ACCESS_REQUIRED" }, { status: 403 });
    }

    const manager = managers[0];

    if (
      body.businessDate !== undefined &&
      (typeof body.businessDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(body.businessDate))
    ) {
      return NextResponse.json({ ok: false, code: "INVALID_BUSINESS_DATE" }, { status: 400 });
    }

    const dates = await sql`
      SELECT COALESCE(
        ${typeof body.businessDate === "string" ? body.businessDate : null}::date,
        ((NOW() AT TIME ZONE timezone)
          - make_interval(mins => business_day_start_minute))::date
      ) AS business_date
      FROM stores
      WHERE id = ${manager.store_id}
    `;
    const businessDate = String(dates[0].business_date).slice(0, 10);

    const [attendance, corrections] = await Promise.all([
      sql`
        SELECT
          st.id AS staff_id,
          st.legal_name,
          COALESCE(ss.state, 'OFF_DUTY') AS state,
          latest.event_type AS last_event_type,
          latest.occurred_at AS last_event_at,
          COALESCE(day_summary.punch_count, 0)::int AS punch_count,
          COALESCE(day_summary.items, '[]'::json) AS day_events
        FROM staff st
        LEFT JOIN staff_states ss ON ss.staff_id = st.id
        LEFT JOIN LATERAL (
          SELECT epe.event_type, epe.occurred_at
          FROM effective_punch_events epe
          JOIN stores store_settings ON store_settings.id = epe.store_id
          WHERE epe.staff_id = st.id
            AND epe.business_date = ${businessDate}::date
          ORDER BY epe.occurred_at DESC, epe.effective_id DESC
          LIMIT 1
        ) latest ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) AS punch_count,
            json_agg(
              json_build_object(
                'effective_id', epe.effective_id,
                'original_event_id', epe.original_event_id,
                'origin_correction_id', epe.origin_correction_id,
                'event_type', epe.event_type,
                'occurred_at', epe.occurred_at,
                'corrected', epe.corrected
              )
              ORDER BY epe.occurred_at ASC, epe.created_at ASC, epe.effective_id ASC
            ) AS items
          FROM effective_punch_events epe
          JOIN stores store_settings ON store_settings.id = epe.store_id
          WHERE epe.staff_id = st.id
            AND epe.business_date = ${businessDate}::date
        ) day_summary ON TRUE
        WHERE st.store_id = ${manager.store_id}
          AND st.status = 'active'
        ORDER BY st.legal_name ASC
      `,
      sql`
        SELECT
          cr.id,
          cr.operation,
          cr.requested_event_type,
          cr.requested_occurred_at,
          cr.reason,
          cr.requested_at,
          st.legal_name,
          pe.event_type AS target_event_type,
          pe.occurred_at AS target_occurred_at,
          COALESCE(day_history.items, '[]'::json) AS day_events
        FROM correction_requests cr
        JOIN staff st ON st.id = cr.staff_id
        JOIN stores store_settings ON store_settings.id = cr.store_id
        LEFT JOIN punch_events pe ON pe.id = cr.target_event_id
        LEFT JOIN LATERAL (
          SELECT json_agg(
            json_build_object(
              'effective_id', epe.effective_id,
              'original_event_id', epe.original_event_id,
              'correction_request_id', epe.correction_request_id,
              'origin_correction_id', epe.origin_correction_id,
              'event_type', epe.event_type,
              'occurred_at', epe.occurred_at,
              'corrected', epe.corrected
            )
            ORDER BY epe.occurred_at ASC, epe.created_at ASC, epe.effective_id ASC
          ) AS items
          FROM effective_punch_events epe
          WHERE epe.staff_id = cr.staff_id
            AND epe.business_date = (
              (
                COALESCE(
                  cr.requested_occurred_at,
                  pe.occurred_at,
                  cr.requested_at
                ) AT TIME ZONE store_settings.timezone
              ) - make_interval(mins => store_settings.business_day_start_minute)
            )::date
        ) day_history ON TRUE
        WHERE cr.store_id = ${manager.store_id}
          AND cr.status = 'PENDING'
        ORDER BY cr.requested_at ASC
      `,
    ]);

    return NextResponse.json({
      ok: true,
      manager,
      businessDate,
      attendance,
      corrections,
    });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    console.error("Manager dashboard failed", error);
    return NextResponse.json({ ok: false, code: "DASHBOARD_UNAVAILABLE" }, { status: 503 });
  }
}
