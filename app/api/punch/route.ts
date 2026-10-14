import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";
import { hashStoreEntryToken } from "@/lib/store-entry-token";
import { enforceRateLimit } from "@/lib/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STORE_RADIUS_METERS = 200;
const MAX_ACCURACY_METERS = 100;

const transitions = {
  CHECK_IN: { from: "OFF_DUTY", to: "WORKING" },
  BREAK_START: { from: "WORKING", to: "ON_BREAK" },
  BREAK_END: { from: "ON_BREAK", to: "WORKING" },
  CHECK_OUT: { from: "WORKING", to: "OFF_DUTY" },
} as const;

type EventType = keyof typeof transitions;

type PunchRequest = {
  idToken?: unknown;
  eventType?: unknown;
  clientRequestId?: unknown;
  expectedStateVersion?: unknown;
  previousCheckoutRequestId?: unknown;
  storeToken?: unknown;
  location?: unknown;
};

type LocationInput = {
  latitude: number;
  longitude: number;
  accuracy: number;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseLocation(value: unknown): LocationInput | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return undefined;

  const candidate = value as Record<string, unknown>;
  const { latitude, longitude, accuracy } = candidate;

  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    typeof accuracy !== "number" ||
    !Number.isFinite(accuracy) ||
    accuracy < 0
  ) {
    return undefined;
  }

  return { latitude, longitude, accuracy };
}

export async function POST(request: Request) {
  let body: PunchRequest;

  try {
    body = (await request.json()) as PunchRequest;
  } catch {
    return NextResponse.json(
      { ok: false, code: "INVALID_JSON" },
      { status: 400 },
    );
  }

  const location = parseLocation(body.location);

  if (
    typeof body.idToken !== "string" ||
    typeof body.eventType !== "string" ||
    !(body.eventType in transitions) ||
    typeof body.clientRequestId !== "string" ||
    !uuidPattern.test(body.clientRequestId) ||
    (body.previousCheckoutRequestId !== undefined &&
      (body.eventType !== 'CHECK_IN' || typeof body.previousCheckoutRequestId !== 'string'
        || !uuidPattern.test(body.previousCheckoutRequestId))) ||
    (body.expectedStateVersion !== undefined &&
      (typeof body.expectedStateVersion !== "string" || !/^\d{1,12}(?:\.\d{1,6})?$/.test(body.expectedStateVersion))) ||
    location === undefined
  ) {
    return NextResponse.json(
      { ok: false, code: "INVALID_REQUEST" },
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
    { scope: "punch", limit: 30, windowSeconds: 60 },
    body.idToken,
  );
  if (limited) return limited;

  const eventType = body.eventType as EventType;
  const transition = transitions[eventType];
  const previousCheckoutRequestId = typeof body.previousCheckoutRequestId === "string"
    ? body.previousCheckoutRequestId.toLowerCase() : null;
  const latitude = location?.latitude ?? null;
  const longitude = location?.longitude ?? null;
  const accuracy = location?.accuracy ?? null;

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({
      mode: "staff",
      lineIdentity: identity.sub,
      storeTokenHash: tokenHash,
    });

    const existing = await sql`
      SELECT
        pe.id AS event_id,
        pe.event_type,
        pe.previous_checkout_request_id,
        pe.occurred_at,
        pe.location_status,
        pe.validation_code,
        ss.state
      FROM punch_events pe
      JOIN staff st ON st.id = pe.staff_id
      JOIN stores s ON s.id = st.store_id
      JOIN staff_states ss ON ss.staff_id = st.id
      JOIN store_entry_tokens setk ON setk.store_id = pe.store_id
      WHERE pe.client_request_id = ${body.clientRequestId}
        AND st.line_user_id = ${identity.sub}
        AND st.status = 'active' AND s.status = 'active'
        AND setk.token_hash = ${tokenHash}
        AND setk.active = TRUE
        AND setk.revoked_at IS NULL
        AND (setk.expires_at IS NULL OR setk.expires_at > NOW())
      LIMIT 1
    `;

    if (existing.length === 1) {
      if (existing[0].event_type !== eventType ||
        (existing[0].previous_checkout_request_id ?? null) !== previousCheckoutRequestId) {
        return NextResponse.json({ ok: false, code: "CLIENT_REQUEST_CONFLICT" }, { status: 409 });
      }
      return NextResponse.json({
        ok: true,
        status: "already_applied",
        punch: existing[0],
      });
    }

    // Old tabs can still recover an already saved operation above. An unsaved
    // request must identify the state it started from, including across a full
    // OFF_DUTY -> WORKING -> OFF_DUTY cycle on another screen.
    if (body.expectedStateVersion === undefined) {
      return NextResponse.json({ ok: false, code: "STATE_VERSION_REQUIRED" }, { status: 400 });
    }

    type TransactionSql = Parameters<Parameters<typeof sql.transaction>[0]>[0];
    const createPunchQuery = (transactionSql: TransactionSql) => transactionSql`
      WITH target AS (
        SELECT
          ss.staff_id,
          st.store_id,
          s.timezone,
          s.business_day_start_minute,
          s.latitude AS store_latitude,
          s.longitude AS store_longitude,
          ${latitude}::double precision AS client_latitude,
          ${longitude}::double precision AS client_longitude,
          ${accuracy}::double precision AS client_accuracy
        FROM staff st
        JOIN stores s ON s.id = st.store_id
        JOIN staff_states ss ON ss.staff_id = st.id
        JOIN store_entry_tokens setk ON setk.store_id = s.id
        WHERE st.line_user_id = ${identity.sub}
          AND st.status = 'active'
          AND s.status = 'active'
          AND setk.token_hash = ${tokenHash}
          AND setk.active = TRUE
          AND setk.revoked_at IS NULL
          AND (setk.expires_at IS NULL OR setk.expires_at > NOW())
          AND (
            (${previousCheckoutRequestId}::uuid IS NULL AND ss.state = ${transition.from})
            OR (${eventType} = 'CHECK_IN' AND EXISTS (
              SELECT 1 FROM staff_pending_shift_start(st.id) next_shift
              WHERE next_shift.request_id = ${previousCheckoutRequestId}::uuid
            ))
          )
          AND EXTRACT(EPOCH FROM ss.updated_at)::text = ${body.expectedStateVersion}
          AND (
            ${eventType} <> 'CHECK_IN'
            OR NOT EXISTS (
              SELECT 1
              FROM staff active_staff
              JOIN staff_states active_state
                ON active_state.staff_id = active_staff.id
              JOIN stores active_store ON active_store.id = active_staff.store_id
              WHERE active_staff.line_user_id = ${identity.sub}
                AND active_staff.status = 'active'
                AND active_store.status = 'active'
                AND active_staff.store_id <> st.store_id
                AND active_state.state IN ('WORKING', 'ON_BREAK')
            )
          )
        ORDER BY st.created_at ASC
        LIMIT 1
        FOR UPDATE OF ss
      ),
      located AS (
        SELECT
          t.*,
          CASE
            WHEN t.store_latitude IS NULL
              OR t.store_longitude IS NULL
              OR t.client_latitude IS NULL
              OR t.client_longitude IS NULL
            THEN NULL
            ELSE 6371000 * 2 * ASIN(
              LEAST(
                1,
                SQRT(
                  POWER(
                    SIN(RADIANS(t.client_latitude - t.store_latitude) / 2),
                    2
                  )
                  + COS(RADIANS(t.store_latitude))
                  * COS(RADIANS(t.client_latitude))
                  * POWER(
                    SIN(RADIANS(t.client_longitude - t.store_longitude) / 2),
                    2
                  )
                )
              )
            )
          END AS distance_m
        FROM target t
      ),
      inserted_event AS (
        INSERT INTO punch_events (
          store_id,
          staff_id,
          event_type,
          occurred_at,
          business_date,
          client_request_id,
          previous_checkout_request_id,
          location_status,
          validation_status,
          validation_code,
          source
        )
        SELECT
          l.store_id,
          l.staff_id,
          ${eventType},
          NOW(),
          CASE
            WHEN ${eventType} = 'CHECK_IN' THEN (
              (NOW() AT TIME ZONE l.timezone)
              - make_interval(mins => l.business_day_start_minute)
            )::date
            ELSE COALESCE(
              (
                SELECT active_check_in.business_date
                FROM effective_punch_events active_check_in
                WHERE active_check_in.staff_id = l.staff_id
                  AND active_check_in.event_type = 'CHECK_IN'
                  AND active_check_in.occurred_at <= NOW()
                ORDER BY active_check_in.occurred_at DESC
                LIMIT 1
              ),
              (
                (NOW() AT TIME ZONE l.timezone)
                - make_interval(mins => l.business_day_start_minute)
              )::date
            )
          END,
          ${body.clientRequestId},
          ${previousCheckoutRequestId}::uuid,
          CASE
            WHEN l.client_latitude IS NULL OR l.client_longitude IS NULL
              THEN 'UNAVAILABLE'
            WHEN l.store_latitude IS NULL OR l.store_longitude IS NULL
              THEN 'UNAVAILABLE'
            WHEN l.client_accuracy > ${MAX_ACCURACY_METERS}
              OR l.distance_m > ${STORE_RADIUS_METERS}
              THEN 'WARNING'
            ELSE 'OK'
          END,
          CASE
            WHEN l.client_latitude IS NULL
              OR l.client_longitude IS NULL
              OR l.store_latitude IS NULL
              OR l.store_longitude IS NULL
              OR l.client_accuracy > ${MAX_ACCURACY_METERS}
              OR l.distance_m > ${STORE_RADIUS_METERS}
              THEN 'WARNING'
            ELSE 'VALID'
          END,
          CASE
            WHEN l.client_latitude IS NULL OR l.client_longitude IS NULL
              THEN 'CLIENT_LOCATION_UNAVAILABLE'
            WHEN l.store_latitude IS NULL OR l.store_longitude IS NULL
              THEN 'STORE_LOCATION_UNAVAILABLE'
            WHEN l.client_accuracy > ${MAX_ACCURACY_METERS}
              THEN 'LOW_GPS_ACCURACY'
            WHEN l.distance_m > ${STORE_RADIUS_METERS}
              THEN 'OUTSIDE_STORE_RADIUS'
            ELSE NULL
          END,
          'LIFF'
        FROM located l
        RETURNING
          id,
          staff_id,
          event_type,
          occurred_at,
          location_status,
          validation_code
      )
      UPDATE staff_states ss
      SET
        state = ${transition.to},
        last_event_id = ie.id,
        last_event_at = ie.occurred_at,
        updated_at = NOW()
      FROM inserted_event ie
      WHERE ss.staff_id = ie.staff_id
      RETURNING
        ie.id AS event_id,
        ie.event_type,
        ie.occurred_at,
        ie.location_status,
        ie.validation_code,
        ss.state
    `;

    const punchTransaction = await sql.transaction(
      (transactionSql) => [
        ...(eventType === "CHECK_IN"
          ? [transactionSql`SELECT pg_advisory_xact_lock(hashtextextended(${identity.sub}, 0))`]
          : []),
        // Decisions/submissions lock state before request. Separate statements
        // give the final eligibility check a fresh snapshot after any wait.
        ...(previousCheckoutRequestId ? [
          transactionSql`SELECT ss.staff_id FROM staff_states ss JOIN staff st ON st.id = ss.staff_id
            WHERE st.line_user_id = ${identity.sub} AND app_token_store_allowed(st.store_id)
            FOR UPDATE OF ss`,
          transactionSql`SELECT id FROM correction_requests
            WHERE id = ${previousCheckoutRequestId}::uuid
              AND app_actor_owns_staff(staff_id) AND app_token_store_allowed(store_id)
            FOR UPDATE`,
        ] : []),
        createPunchQuery(transactionSql),
      ],
      { isolationLevel: "ReadCommitted" },
    );
    const result = punchTransaction[punchTransaction.length - 1];

    if (result.length === 1) {
      return NextResponse.json({
        ok: true,
        status: "applied",
        punch: result[0],
      });
    }

    const membership = await sql`
      SELECT ss.state
      FROM staff st
      JOIN stores s ON s.id = st.store_id
      JOIN staff_states ss ON ss.staff_id = st.id
      JOIN store_entry_tokens setk ON setk.store_id = s.id
      WHERE st.line_user_id = ${identity.sub}
        AND st.status = 'active'
        AND s.status = 'active'
        AND setk.token_hash = ${tokenHash}
        AND setk.active = TRUE
        AND setk.revoked_at IS NULL
        AND (setk.expires_at IS NULL OR setk.expires_at > NOW())
      ORDER BY st.created_at ASC
      LIMIT 1
    `;

    if (membership.length === 0) {
      return NextResponse.json(
        { ok: false, code: "STAFF_NOT_REGISTERED" },
        { status: 404 },
      );
    }

    if (eventType === "CHECK_IN") {
      const activeElsewhere = await sql`
        SELECT
          active_store.id AS store_id,
          active_store.name AS store_name,
          active_state.state
        FROM staff requested_staff
        JOIN stores requested_store
          ON requested_store.id = requested_staff.store_id
        JOIN store_entry_tokens setk
          ON setk.store_id = requested_store.id
        JOIN staff active_staff
          ON active_staff.line_user_id = requested_staff.line_user_id
          AND active_staff.store_id <> requested_staff.store_id
        JOIN stores active_store ON active_store.id = active_staff.store_id
        JOIN staff_states active_state
          ON active_state.staff_id = active_staff.id
        WHERE requested_staff.line_user_id = ${identity.sub}
          AND requested_staff.status = 'active'
          AND requested_store.status = 'active'
          AND setk.token_hash = ${tokenHash}
          AND setk.active = TRUE
          AND setk.revoked_at IS NULL
          AND (setk.expires_at IS NULL OR setk.expires_at > NOW())
          AND active_staff.status = 'active'
          AND active_store.status = 'active'
          AND active_state.state IN ('WORKING', 'ON_BREAK')
        ORDER BY active_state.updated_at DESC
        LIMIT 1
      `;

      if (activeElsewhere.length === 1) {
        const activeStore = activeElsewhere[0];
        return NextResponse.json(
          {
            ok: false,
            code: "ACTIVE_AT_OTHER_STORE",
            message: `現在${activeStore.store_name}で勤務中です。${activeStore.store_name}で退勤してから出勤してください。`,
            activeStore,
          },
          { status: 409 },
        );
      }
    }

    return NextResponse.json(
      {
        ok: false,
        code: "INVALID_STATE_TRANSITION",
        currentState: membership[0].state,
      },
      { status: 409 },
    );
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json(
        { ok: false, code: "INVALID_ID_TOKEN" },
        { status: 401 },
      );
    }

    logServerError("punch_failed");

    return NextResponse.json(
      { ok: false, code: "PUNCH_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
