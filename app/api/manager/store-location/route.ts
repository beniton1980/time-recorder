import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";
import { enforceRateLimit } from "@/lib/api-security";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  idToken?: unknown;
  storeId?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  accuracy?: unknown;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REGISTRATION_ACCURACY_METERS = 100;

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json() as Body;
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 });
  }

  if (
    typeof body.idToken !== "string" ||
    typeof body.storeId !== "string" ||
    !uuidPattern.test(body.storeId) ||
    typeof body.latitude !== "number" ||
    !Number.isFinite(body.latitude) ||
    body.latitude < -90 || body.latitude > 90 ||
    typeof body.longitude !== "number" ||
    !Number.isFinite(body.longitude) ||
    body.longitude < -180 || body.longitude > 180 ||
    typeof body.accuracy !== "number" ||
    !Number.isFinite(body.accuracy) ||
    body.accuracy < 0
  ) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  if (body.accuracy > MAX_REGISTRATION_ACCURACY_METERS) {
    return NextResponse.json({ ok: false, code: "LOCATION_ACCURACY_TOO_LOW" }, { status: 422 });
  }

  const limited = await enforceRateLimit(
    request,
    { scope: "manager-store-location", limit: 10, windowSeconds: 600 },
    body.idToken,
  );
  if (limited) return limited;

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({ mode: "manager", lineIdentity: identity.sub, storeId: body.storeId });
    const rows = await sql`
      SELECT * FROM public.set_manager_store_location(
        ${identity.sub},
        ${body.storeId}::uuid,
        ${body.latitude}::double precision,
        ${body.longitude}::double precision
      )
    `;
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, code: "MANAGER_ACCESS_REQUIRED" }, { status: 403 });
    }
    return NextResponse.json({ ok: true, store: rows[0] });
  } catch (caught) {
    if (caught instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    const message = caught instanceof Error ? caught.message : "";
    if (message.includes("MANAGER_ACCESS_REQUIRED")) {
      return NextResponse.json({ ok: false, code: "MANAGER_ACCESS_REQUIRED" }, { status: 403 });
    }
    if (message.includes("STORE_NOT_FOUND")) {
      return NextResponse.json({ ok: false, code: "STORE_NOT_FOUND" }, { status: 404 });
    }
    logServerError("manager_store_location_update_failed");
    return NextResponse.json({ ok: false, code: "STORE_LOCATION_UNAVAILABLE" }, { status: 503 });
  }
}
