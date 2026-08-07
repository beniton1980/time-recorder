import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";
import { hashStoreEntryToken } from "@/lib/store-entry-token";

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

  const eventType = body.eventType as EventType;
  const transition = transitions[eventType];
  const latitude = location?.latitude ?? null;
  const longitude = location?.longitude ?? null;
  const accuracy = location?.accuracy ?? null;

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql();

    const existing = await sql`
      SELECT
        pe.id AS event_id,
        pe.event_type,
        pe.occurred_at,
        pe.location_status,
        pe.validation_code,
        pe.distance_from_store_m,
        ss.state
      FROM punch_events pe
      JOIN staff st ON st.id = pe.staff_id
      JOIN staff_states ss ON ss.staff_id = st.id
      JOIN store_entry_tokens setk ON setk.store_id = pe.store_id
      WHERE pe.client_request_id = ${body.clientRequestId}
        AND st.line_user_id = ${identity.sub}
        AND setk.token_hash = ${tokenHash}
        AND setk.active = TRUE
        AND setk.revoked_at IS NULL
        AND (setk.expires_at IS NULL OR setk.expires_at > NOW())
      LIMIT 1
    `;

    if (existing.length === 1) {
      return NextResponse.json({
        ok: true,
        status: "already_applied",
        punch: existing[0],
      });
    }

    const result = await sql`
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
          AND ss.state = ${transition.from}
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
          latitude,
          longitude,
          gps_accuracy_m,
          distance_from_store_m,
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
          (
            (NOW() AT TIME ZONE l.timezone)
            - make_interval(mins => l.business_day_start_minute)
          )::date,
          ${body.clientRequestId},
          l.client_latitude,
          l.client_longitude,
          l.client_accuracy,
          l.distance_m,
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
          validation_code,
          distance_from_store_m
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
        ie.distance_from_store_m,
        ss.state
    `;

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

    console.error("Punch failed", error);

    return NextResponse.json(
      { ok: false, code: "PUNCH_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
