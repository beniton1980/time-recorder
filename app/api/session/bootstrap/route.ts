import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type BootstrapRequest = {
  idToken?: unknown;
};

export async function POST(request: Request) {
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

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql();

    const memberships = await sql`
      SELECT
        st.id AS staff_id,
        st.legal_name,
        s.id AS store_id,
        s.name AS store_name,
        COALESCE(ss.state, 'OFF_DUTY') AS state,
        ss.last_event_at
      FROM staff st
      JOIN stores s ON s.id = st.store_id
      LEFT JOIN staff_states ss ON ss.staff_id = st.id
      WHERE st.line_user_id = ${identity.sub}
        AND st.status = 'active'
        AND s.status = 'active'
      ORDER BY st.created_at ASC
    `;

    if (memberships.length === 0) {
      return NextResponse.json({
        ok: true,
        registered: false,
      });
    }

    return NextResponse.json({
      ok: true,
      registered: true,
      memberships,
    });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json(
        { ok: false, code: "INVALID_ID_TOKEN" },
        { status: 401 },
      );
    }

    console.error("Session bootstrap failed", error);

    return NextResponse.json(
      { ok: false, code: "BOOTSTRAP_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
