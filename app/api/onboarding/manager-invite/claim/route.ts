import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ClaimRequest = {
  idToken?: unknown;
  inviteToken?: unknown;
};

function tokenHash(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

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

  if (
    typeof body.inviteToken !== "string"
    || body.inviteToken.length < 40
    || body.inviteToken.length > 100
  ) {
    return NextResponse.json(
      { ok: false, code: "INVALID_INVITE_TOKEN" },
      { status: 400 },
    );
  }

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql();

    const claimed = await sql`
      SELECT *
      FROM claim_onboarding_manager_invite(
        ${tokenHash(body.inviteToken)},
        ${identity.sub}
      )
    `;

    const result = claimed[0];

    return NextResponse.json({
      ok: true,
      manager: {
        staffId: result.staff_id,
        storeId: result.store_id,
        storeName: result.store_name,
      },
    });
  } catch (error) {
    if (error instanceof LineTokenVerificationError) {
      return NextResponse.json(
        { ok: false, code: "INVALID_ID_TOKEN" },
        { status: 401 },
      );
    }

    const message = error instanceof Error ? error.message : "";
    if (message.includes("MANAGER_INVITE_INVALID")) {
      return NextResponse.json(
        { ok: false, code: "MANAGER_INVITE_INVALID" },
        { status: 410 },
      );
    }

    console.error("Manager invite claim failed", error);
    return NextResponse.json(
      { ok: false, code: "MANAGER_INVITE_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
