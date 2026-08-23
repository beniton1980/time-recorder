import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { getSql } from "@/lib/db";
import { verifyLineIdToken, LineTokenVerificationError } from "@/lib/line/verify-id-token";
import { logServerError } from "@/lib/safe-log";

export const runtime = "nodejs";
const tokenHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export async function POST(request: Request) {
  let body: { idToken?: unknown; inviteToken?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  if (typeof body.idToken !== "string" || typeof body.inviteToken !== "string" || body.inviteToken.length < 40 || body.inviteToken.length > 100) return NextResponse.json({ ok: false, code: "INVALID_INPUT" }, { status: 400 });
  const limited = await enforceRateLimit(request, { scope: "manager-invite-claim", limit: 20, windowSeconds: 300 }, body.inviteToken);
  if (limited) return limited;
  try {
    const identity = await verifyLineIdToken(body.idToken);
    const hash = tokenHash(body.inviteToken);
    const sql = getSql({ mode: "invite_claim", lineIdentity: identity.sub, inviteTokenHash: hash });
    const rows = await sql`SELECT * FROM claim_store_manager_invite(${identity.sub}, ${hash})`;
    if (rows.length === 0) return NextResponse.json({ ok: false, code: "MANAGER_INVITE_INVALID" }, { status: 409 });
    return NextResponse.json({ ok: true, manager: rows[0] });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    logServerError("manager_invite_claim_failed");
    return NextResponse.json({ ok: false, code: "CLAIM_UNAVAILABLE" }, { status: 503 });
  }
}
