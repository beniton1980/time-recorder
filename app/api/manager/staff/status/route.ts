import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  idToken?: unknown;
  storeId?: unknown;
  staffId?: unknown;
  status?: unknown;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    typeof body.staffId !== "string" ||
    !uuidPattern.test(body.staffId) ||
    (body.status !== "active" && body.status !== "inactive")
  ) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql();
    const rows = await sql`
      SELECT * FROM set_staff_membership_status(
        ${identity.sub}, ${body.storeId}::uuid, ${body.staffId}, ${body.status}
      )
    `;
    return NextResponse.json({ ok: true, staff: rows[0] });
  } catch (caught) {
    if (caught instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }

    const message = caught instanceof Error ? caught.message : "";
    const knownErrors: Record<string, number> = {
      MANAGER_ACCESS_REQUIRED: 403,
      STAFF_NOT_FOUND: 404,
      STAFF_ACTIVE_WORK: 409,
      INVALID_STAFF_STATUS: 400,
    };
    for (const [code, status] of Object.entries(knownErrors)) {
      if (message.includes(code)) {
        return NextResponse.json({ ok: false, code }, { status });
      }
    }

    logServerError("manager_staff_status_update_failed");
    return NextResponse.json({ ok: false, code: "STAFF_STATUS_UNAVAILABLE" }, { status: 503 });
  }
}

