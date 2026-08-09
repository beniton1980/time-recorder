import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const tokenHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export async function POST(request: Request) {
  let body: { idToken?: unknown; inviteToken?: unknown };
  try { body = await request.json(); } catch {
    return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 });
  }
  if (typeof body.idToken !== "string" || typeof body.inviteToken !== "string"
    || body.inviteToken.length < 40 || body.inviteToken.length > 100) {
    return NextResponse.json({ ok: false, code: "INVALID_STAFF_INVITE" }, { status: 400 });
  }
  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql();
    const rows = await sql`SELECT * FROM claim_staff_invite(
      ${tokenHash(body.inviteToken)}, ${identity.sub}
    )`;
    return NextResponse.json({ ok: true, staff: rows[0] });
  } catch (caught) {
    if (caught instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    const message = caught instanceof Error ? caught.message : "";
    for (const code of ["STAFF_INVITE_INVALID", "STAFF_ALREADY_REGISTERED", "STORE_NOT_ACTIVE"]) {
      if (message.includes(code)) return NextResponse.json({ ok: false, code }, { status: 409 });
    }
    console.error("Staff invite claim failed", caught);
    return NextResponse.json({ ok: false, code: "STAFF_INVITE_UNAVAILABLE" }, { status: 503 });
  }
}
