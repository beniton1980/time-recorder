import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";
import { hashStoreEntryToken } from "@/lib/store-entry-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  idToken?: unknown;
  storeToken?: unknown;
  legalName?: unknown;
};

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json() as Body;
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 });
  }

  const tokenHash = hashStoreEntryToken(body.storeToken);
  const legalName = typeof body.legalName === "string" ? body.legalName.trim() : "";
  if (typeof body.idToken !== "string" || !tokenHash || !legalName || legalName.length > 100) {
    return NextResponse.json({ ok: false, code: "INVALID_SELF_REGISTRATION" }, { status: 400 });
  }

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql();
    const rows = await sql`
      SELECT * FROM self_register_staff(
        ${tokenHash}, ${identity.sub}, ${legalName}
      )
    `;
    return NextResponse.json({ ok: true, staff: rows[0] }, { status: 201 });
  } catch (caught) {
    if (caught instanceof LineTokenVerificationError) {
      return NextResponse.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    const message = caught instanceof Error ? caught.message : "";
    if (message.includes("STORE_TOKEN_INVALID")) {
      return NextResponse.json({ ok: false, code: "STORE_TOKEN_INVALID" }, { status: 403 });
    }
    if (message.includes("STAFF_ALREADY_REGISTERED")) {
      return NextResponse.json({ ok: false, code: "STAFF_ALREADY_REGISTERED" }, { status: 409 });
    }
    console.error("Staff self-registration failed", caught);
    return NextResponse.json({ ok: false, code: "SELF_REGISTRATION_UNAVAILABLE" }, { status: 503 });
  }
}
