import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";
import { ensureManagerRichMenuLinked } from "@/lib/line/manager-rich-menu";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";
import { enforceRateLimit } from "@/lib/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ManagerSessionRequest = {
  idToken?: unknown;
};

export async function POST(request: Request) {
  let body: ManagerSessionRequest;

  try {
    body = (await request.json()) as ManagerSessionRequest;
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

  const limited = await enforceRateLimit(
    request,
    { scope: "manager-session", limit: 60, windowSeconds: 300 },
    body.idToken,
  );
  if (limited) return limited;

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({ mode: "manager", lineIdentity: identity.sub });

    const memberships = await sql`
      SELECT
        st.id AS staff_id,
        st.legal_name,
        st.role,
        s.id AS store_id,
        s.name AS store_name
      FROM staff st
      JOIN stores s ON s.id = st.store_id
      LEFT JOIN staff_manager_access access
        ON access.staff_id = st.id AND access.store_id = st.store_id
      WHERE st.line_user_id = ${identity.sub}
        AND st.status = 'active'
        AND (st.role = 'MANAGER' OR access.status = 'active')
        AND s.status = 'active'
      ORDER BY st.created_at ASC
    `;

    if (memberships.length === 0) {
      return NextResponse.json(
        { ok: false, code: "MANAGER_ACCESS_REQUIRED" },
        { status: 403 },
      );
    }

    const richMenu = await ensureManagerRichMenuLinked(identity.sub);
    console.info("manager_rich_menu_sync", {
      state: richMenu.state,
      ...(richMenu.state === "error" ? { step: richMenu.step, status: richMenu.status ?? null } : {}),
      ...(richMenu.state === "not_friend" ? { status: richMenu.status } : {}),
    });

    return NextResponse.json({
      ok: true,
      manager: {
        lineUserId: identity.sub,
        memberships,
        richMenu: richMenu.state,
      },
    });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json(
        { ok: false, code: "INVALID_ID_TOKEN" },
        { status: 401 },
      );
    }

    logServerError("manager_session_failed");

    return NextResponse.json(
      { ok: false, code: "MANAGER_SESSION_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
