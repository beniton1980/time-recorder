import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEST_STAFF_ID = "d0976e41-3fa0-41fc-95b7-b3c33124aef8";
const UNCLAIMED_LINE_USER_ID = "test-line-user-v2";

type ClaimRequest = {
  idToken?: unknown;
};

export async function POST(request: Request) {
  let body: ClaimRequest;

  try {
    body = (await request.json()) as ClaimRequest;
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

    const claimed = await sql`
      UPDATE staff
      SET
        line_user_id = ${identity.sub},
        updated_at = NOW()
      WHERE id = ${TEST_STAFF_ID}
        AND line_user_id = ${UNCLAIMED_LINE_USER_ID}
        AND status = 'active'
      RETURNING id
    `;

    if (claimed.length === 1) {
      return NextResponse.json({ ok: true, status: "claimed" });
    }

    const existing = await sql`
      SELECT id
      FROM staff
      WHERE id = ${TEST_STAFF_ID}
        AND line_user_id = ${identity.sub}
        AND status = 'active'
      LIMIT 1
    `;

    if (existing.length === 1) {
      return NextResponse.json({ ok: true, status: "already_claimed" });
    }

    return NextResponse.json(
      { ok: false, code: "TEST_STAFF_UNAVAILABLE" },
      { status: 409 },
    );
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json(
        { ok: false, code: "INVALID_ID_TOKEN" },
        { status: 401 },
      );
    }

    console.error("Test staff claim failed", error);

    return NextResponse.json(
      { ok: false, code: "CLAIM_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
