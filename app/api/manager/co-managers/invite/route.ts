import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { getSql } from "@/lib/db";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { logServerError } from "@/lib/safe-log";

export const runtime = "nodejs";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export async function POST(request: Request) {
  let body: { idToken?: unknown; storeId?: unknown; legalName?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  const legalName = typeof body.legalName === "string" ? body.legalName.trim() : "";
  if (typeof body.idToken !== "string" || typeof body.storeId !== "string" || !uuidPattern.test(body.storeId) || legalName.length < 1 || legalName.length > 100) {
    return NextResponse.json({ ok: false, code: "INVALID_INPUT" }, { status: 400 });
  }
  const limited = await enforceRateLimit(request, { scope: "manager-invite", limit: 20, windowSeconds: 300 }, body.idToken);
  if (limited) return limited;
  try {
    const identity = await verifyLineIdToken(body.idToken);
    const rawToken = randomBytes(32).toString("base64url");
    const sql = getSql({ mode: "manager", lineIdentity: identity.sub, storeId: body.storeId });
    const rows = await sql`SELECT * FROM create_store_manager_invite(${identity.sub}, ${body.storeId}::uuid, ${legalName}, ${tokenHash(rawToken)})`;
    if (rows.length === 0) return NextResponse.json({ ok: false, code: "MANAGER_ACCESS_REQUIRED" }, { status: 403 });
    return NextResponse.json({ ok: true, invite: { url: `https://liff.line.me/2010761826-6FNSE1PD/manager/invite?token=${rawToken}`, expiresAt: rows[0].expires_at } });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    logServerError("manager_invite_create_failed");
    return NextResponse.json({ ok: false, code: "INVITE_UNAVAILABLE" }, { status: 503 });
  }
}
