import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { logServerError, logServerInfo } from "@/lib/safe-log";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";
import { hashStoreEntryToken } from "@/lib/store-entry-token";
import { enforceRateLimit } from "@/lib/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type BootstrapRequest = {
  idToken?: unknown;
  storeToken?: unknown;
};

export async function POST(request: Request) {
  const startedAt = Date.now();
  let body: BootstrapRequest;

  try {
    body = (await request.json()) as BootstrapRequest;
  } catch {
    return NextResponse.json(
      { ok: false, code: "INVALID_JSON" },
      { status: 400 },
    );
  }

  if (typeof body.idToken !== "string" || body.idToken.length === 0) {
    return NextResponse.json(
      { ok: false, code: "ID_TOKEN_REQUIRED" },
      { status: 400 },
    );
  }

  const tokenHash = hashStoreEntryToken(body.storeToken);

  if (!tokenHash) {
    return NextResponse.json(
      { ok: false, code: "STORE_TOKEN_REQUIRED" },
      { status: 400 },
    );
  }

  const limited = await enforceRateLimit(
    request,
    { scope: "session-bootstrap", limit: 60, windowSeconds: 300 },
    body.idToken,
  );
  if (limited) return limited;

  try {
    const verificationStartedAt = Date.now();
    const identity = await verifyLineIdToken(body.idToken);
    const lineVerificationMs = Date.now() - verificationStartedAt;
    const sql = getSql({
      mode: "staff",
      lineIdentity: identity.sub,
      storeTokenHash: tokenHash,
    });
    const databaseStartedAt = Date.now();

    const memberships = await sql`
      SELECT
        st.id AS staff_id,
        st.legal_name,
        s.id AS store_id,
        s.name AS store_name,
        COALESCE(ss.state, 'OFF_DUTY') AS state,
        ss.last_event_id,
        COALESCE(epe.occurred_at, ss.last_event_at) AS last_event_at,
        epe.event_type AS last_event_type,
        COALESCE(history.items, '[]'::json) AS recent_punches,
        (
          SELECT json_build_object(
            'store_id', active_store.id,
            'store_name', active_store.name,
            'state', active_state.state
          )
          FROM staff active_staff
          JOIN stores active_store ON active_store.id = active_staff.store_id
          JOIN staff_states active_state ON active_state.staff_id = active_staff.id
          WHERE active_staff.line_user_id = st.line_user_id
            AND active_staff.status = 'active'
            AND active_store.status = 'active'
            AND active_staff.store_id <> st.store_id
            AND active_state.state IN ('WORKING', 'ON_BREAK')
          ORDER BY active_state.updated_at DESC
          LIMIT 1
        ) AS active_store_conflict
      FROM staff st
      JOIN stores s ON s.id = st.store_id
      JOIN store_entry_tokens setk ON setk.store_id = s.id
      LEFT JOIN staff_states ss ON ss.staff_id = st.id
      LEFT JOIN effective_punch_events epe
        ON epe.original_event_id = ss.last_event_id
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'effective_id', recent.effective_id,
            'original_event_id', recent.original_event_id,
            'event_type', recent.event_type,
            'occurred_at', recent.occurred_at,
            'corrected', recent.corrected
          )
          ORDER BY recent.occurred_at ASC
        ) AS items
        FROM (
          SELECT
            day_events.effective_id,
            day_events.original_event_id,
            day_events.event_type,
            day_events.occurred_at,
            day_events.corrected
          FROM effective_punch_events day_events
          WHERE day_events.staff_id = st.id
            AND day_events.business_date = (
              (NOW() AT TIME ZONE s.timezone)
              - make_interval(mins => s.business_day_start_minute)
            )::date
          ORDER BY day_events.occurred_at DESC
          LIMIT 8
        ) recent
      ) history ON TRUE
      WHERE st.line_user_id = ${identity.sub}
        AND st.status = 'active'
        AND s.status = 'active'
        AND setk.token_hash = ${tokenHash}
        AND setk.active = TRUE
        AND setk.revoked_at IS NULL
        AND (setk.expires_at IS NULL OR setk.expires_at > NOW())
      ORDER BY st.created_at ASC
    `;

    if (memberships.length === 0) {
      const inactiveMemberships = await sql`
        SELECT st.id
        FROM staff st
        JOIN stores s ON s.id = st.store_id
        JOIN store_entry_tokens token ON token.store_id = s.id
        WHERE st.line_user_id = ${identity.sub}
          AND st.status = 'inactive'
          AND s.status = 'active'
          AND token.token_hash = ${tokenHash}
          AND token.active = TRUE
          AND token.revoked_at IS NULL
          AND (token.expires_at IS NULL OR token.expires_at > NOW())
        LIMIT 1
      `;

      if (inactiveMemberships.length === 1) {
        return NextResponse.json(
          { ok: false, code: "STAFF_INACTIVE" },
          { status: 403 },
        );
      }

      const targetStores = await sql`
        SELECT s.id AS store_id, s.name AS store_name
        FROM store_entry_tokens token
        JOIN stores s ON s.id = token.store_id
        WHERE token.token_hash = ${tokenHash}
          AND token.active = TRUE
          AND token.revoked_at IS NULL
          AND (token.expires_at IS NULL OR token.expires_at > NOW())
          AND s.status = 'active'
        LIMIT 1
      `;

      if (targetStores.length === 0) {
        return NextResponse.json(
          { ok: false, code: "STORE_TOKEN_INVALID" },
          { status: 403 },
        );
      }

      return NextResponse.json({
        ok: true,
        registered: false,
        store: targetStores[0],
      });
    }

    const databaseMs = Date.now() - databaseStartedAt;
    const activeStoreConflict = memberships[0].active_store_conflict ?? null;

    logServerInfo("session_bootstrap_completed", {
      route: "/api/session/bootstrap",
      lineVerificationMs,
      databaseMs,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      ok: true,
      registered: true,
      memberships,
      activeStoreConflict,
    });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json(
        { ok: false, code: "INVALID_ID_TOKEN" },
        { status: 401 },
      );
    }

    logServerError("session_bootstrap_failed", {
      route: "/api/session/bootstrap",
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(
      { ok: false, code: "BOOTSTRAP_UNAVAILABLE" },
      { status: 503 },
    );
  }
}

