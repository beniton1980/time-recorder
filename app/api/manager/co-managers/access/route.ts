import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { getSql } from "@/lib/db";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { logServerError } from "@/lib/safe-log";

export const runtime = "nodejs";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  let body: { idToken?: unknown; storeId?: unknown; staffId?: unknown; status?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  if (typeof body.idToken !== "string" || typeof body.storeId !== "string" || !uuidPattern.test(body.storeId) || typeof body.staffId !== "string" || !uuidPattern.test(body.staffId) || !["active", "inactive"].includes(String(body.status))) {
    return NextResponse.json({ ok: false, code: "INVALID_INPUT" }, { status: 400 });
  }
  const limited = await enforceRateLimit(request, { scope: "manager-access", limit: 30, windowSeconds: 300 }, body.idToken);
  if (limited) return limited;
  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({ mode: "manager", lineIdentity: identity.sub, storeId: body.storeId });
    const rows = await sql`SELECT * FROM set_staff_manager_access(${identity.sub}, ${body.storeId}::uuid, ${body.staffId}::uuid, ${String(body.status)})`;
    if (rows.length === 0) return NextResponse.json({ ok: false, code: "ACCESS_CHANGE_NOT_ALLOWED" }, { status: 409 });
    return NextResponse.json({ ok: true, manager: rows[0] });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    logServerError("staff_manager_access_change_failed");
    return NextResponse.json({ ok: false, code: "ACCESS_UNAVAILABLE" }, { status: 503 });
  }
}
