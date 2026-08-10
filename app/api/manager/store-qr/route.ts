import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { getSql } from "@/lib/db";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIFF_ID = "2010761826-6FNSE1PD";

type TokenRequest = {
  idToken?: unknown;
  storeId?: unknown;
  action?: unknown;
};

function hashToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function error(code: string, status: number) {
  return NextResponse.json({ ok: false, code }, { status });
}

export async function POST(request: Request) {
  let body: TokenRequest;
  try {
    body = (await request.json()) as TokenRequest;
  } catch {
    return error("INVALID_JSON", 400);
  }

  if (typeof body.idToken !== "string" || body.idToken.length === 0) {
    return error("ID_TOKEN_REQUIRED", 400);
  }
  if (
    typeof body.storeId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.storeId)
  ) {
    return error("INVALID_STORE_ID", 400);
  }
  if (!["STATUS", "ROTATE", "REVOKE"].includes(String(body.action))) {
    return error("INVALID_ACTION", 400);
  }

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql();
    const managers = await sql`
      SELECT st.id AS staff_id, s.id AS store_id, s.name AS store_name
      FROM staff st
      JOIN stores s ON s.id = st.store_id
      WHERE st.line_user_id = ${identity.sub}
        AND st.store_id = ${body.storeId}::uuid
        AND st.status = 'active'
        AND st.role = 'MANAGER'
        AND s.status = 'active'
      LIMIT 1
    `;

    if (managers.length === 0) {
      return error("MANAGER_ACCESS_REQUIRED", 403);
    }

    const manager = managers[0];
    if (body.action === "STATUS") {
      const active = await sql`
        SELECT COUNT(*)::int AS active_count, MAX(created_at) AS issued_at
        FROM store_entry_tokens
        WHERE store_id = ${manager.store_id}
          AND active = TRUE
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
      `;
      return NextResponse.json({
        ok: true,
        store: manager,
        token: {
          active: Number(active[0].active_count) > 0,
          issuedAt: active[0].issued_at,
        },
      });
    }

    if (body.action === "REVOKE") {
      const revoked = await sql`
        SELECT revoke_store_entry_tokens(${manager.store_id}) AS revoked_count
      `;
      return NextResponse.json({
        ok: true,
        store: manager,
        revokedCount: Number(revoked[0].revoked_count),
      });
    }

    const rawToken = randomBytes(32).toString("base64url");
    const rotated = await sql`
      SELECT *
      FROM rotate_store_entry_token(
        ${manager.store_id},
        ${hashToken(rawToken)}
      )
    `;
    const entryUrl = `https://liff.line.me/${LIFF_ID}?store_token=${encodeURIComponent(rawToken)}`;
    const qrSvg = await QRCode.toString(entryUrl, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 2,
      width: 720,
    });

    return NextResponse.json({
      ok: true,
      store: manager,
      entryUrl,
      qrSvg,
      token: {
        id: rotated[0].entry_token_id,
        revokedCount: Number(rotated[0].revoked_count),
      },
      warning: "このQRは再表示できません。今すぐ保存してください。",
    });
  } catch (caught) {
    if (caught instanceof LineTokenVerificationError) {
      return error("INVALID_ID_TOKEN", 401);
    }
    const message = caught instanceof Error ? caught.message : "";
    if (message.includes("STORE_NOT_ACTIVE")) {
      return error("STORE_NOT_ACTIVE", 409);
    }
    console.error("Store QR token operation failed", caught);
    return error("STORE_QR_UNAVAILABLE", 503);
  }
}
