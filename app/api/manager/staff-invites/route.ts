import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  idToken?: unknown;
  storeId?: unknown;
  action?: unknown;
  legalName?: unknown;
  clientRequestId?: unknown;
  inviteId?: unknown;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const error = (code: string, status: number) =>
  NextResponse.json({ ok: false, code }, { status });

export async function POST(request: Request) {
  let body: Body;
  try { body = await request.json() as Body; } catch { return error("INVALID_JSON", 400); }
  if (typeof body.idToken !== "string" || !uuid.test(String(body.storeId))) {
    return error("INVALID_REQUEST", 400);
  }
  if (!["ISSUE", "REVOKE"].includes(String(body.action))) return error("INVALID_ACTION", 400);

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql();
    const managers = await sql`
      SELECT id FROM staff
      WHERE line_user_id = ${identity.sub}
        AND store_id = ${body.storeId}::uuid
        AND role = 'MANAGER' AND status = 'active'
      LIMIT 1
    `;
    if (managers.length === 0) return error("MANAGER_ACCESS_REQUIRED", 403);

    if (body.action === "REVOKE") {
      if (typeof body.inviteId !== "string" || !uuid.test(body.inviteId)) {
        return error("INVALID_INVITE_ID", 400);
      }
      const rows = await sql`SELECT revoke_staff_invite(
        ${body.inviteId}::uuid, ${body.storeId}::uuid, ${managers[0].id}::uuid
      ) AS revoked`;
      return NextResponse.json({ ok: true, revoked: rows[0].revoked === true });
    }

    const legalName = typeof body.legalName === "string" ? body.legalName.trim() : "";
    if (!legalName || legalName.length > 100 || typeof body.clientRequestId !== "string" || !uuid.test(body.clientRequestId)) {
      return error("INVALID_STAFF_INVITE", 400);
    }
    const rawToken = randomBytes(32).toString("base64url");
    const rows = await sql`SELECT * FROM issue_staff_invite(
      ${body.storeId}::uuid, ${legalName}, ${hash(rawToken)},
      ${body.clientRequestId}::uuid, ${managers[0].id}::uuid
    )`;
    const inviteUrl = new URL(`/staff/invite?token=${encodeURIComponent(rawToken)}`, request.url).toString();
    return NextResponse.json({
      ok: true,
      invite: { id: rows[0].invite_id, url: inviteUrl, expiresAt: rows[0].invite_expires_at },
    }, { status: 201 });
  } catch (caught) {
    if (caught instanceof LineTokenVerificationError) return error("INVALID_ID_TOKEN", 401);
    const message = caught instanceof Error ? caught.message : "";
    if (message.includes("STAFF_INVITE_ALREADY_ISSUED")) return error("STAFF_INVITE_ALREADY_ISSUED", 409);
    console.error("Staff invite operation failed", caught);
    return error("STAFF_INVITE_UNAVAILABLE", 503);
  }
}
