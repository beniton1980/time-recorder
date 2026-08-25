import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";
import {
  decryptStoreEntryToken,
  encryptStoreEntryToken,
} from "@/lib/store-qr-encryption";
import { hashStoreEntryToken } from "@/lib/store-entry-token";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";
import { enforceRateLimit } from "@/lib/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIFF_ID = "2010761826-6FNSE1PD";

type TokenRequest = {
  idToken?: unknown;
  storeId?: unknown;
  action?: unknown;
};

type StoreQrAction = "STATUS" | "DISPLAY" | "ROTATE" | "REVOKE";

function error(code: string, status: number) {
  return NextResponse.json({ ok: false, code }, { status });
}

async function renderQr(rawToken: string) {
  const entryUrl = `https://liff.line.me/${LIFF_ID}?store_token=${encodeURIComponent(rawToken)}`;
  const qrSvg = await QRCode.toString(entryUrl, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 720,
  });
  const qrPngDataUrl = await QRCode.toDataURL(entryUrl, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 720,
  });
  return { entryUrl, qrSvg, qrPngDataUrl };
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

  const action = String(body.action) as StoreQrAction;
  if (!["STATUS", "DISPLAY", "ROTATE", "REVOKE"].includes(action)) {
    return error("INVALID_ACTION", 400);
  }

  const readOnlyAction = action === "STATUS" || action === "DISPLAY";
  const limited = await enforceRateLimit(
    request,
    {
      scope: readOnlyAction ? "manager-store-qr-read" : "manager-store-qr-write",
      limit: readOnlyAction ? 30 : 10,
      windowSeconds: 600,
    },
    body.idToken,
  );
  if (limited) return limited;

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql({
      mode: "manager",
      lineIdentity: identity.sub,
      storeId: body.storeId,
    });
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
    const managerStoreId = String(manager.store_id);

    if (action === "STATUS") {
      const active = await sql`
        SELECT
          COUNT(*)::int AS active_count,
          MAX(created_at) AS issued_at,
          COALESCE(BOOL_OR(token_ciphertext IS NOT NULL), FALSE) AS display_ready
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
          displayReady: Boolean(active[0].display_ready),
        },
      });
    }

    if (action === "DISPLAY") {
      const active = await sql`
        SELECT token_hash, token_ciphertext, created_at
        FROM store_entry_tokens
        WHERE store_id = ${manager.store_id}
          AND active = TRUE
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC
        LIMIT 1
      `;

      if (active.length === 0) {
        return error("STORE_QR_NOT_ACTIVE", 404);
      }
      if (!active[0].token_ciphertext) {
        return error("QR_REISSUE_REQUIRED", 409);
      }

      const rawToken = decryptStoreEntryToken(
        String(active[0].token_ciphertext),
        managerStoreId,
      );
      const tokenHash = hashStoreEntryToken(rawToken);
      if (!tokenHash || tokenHash !== active[0].token_hash) {
        logServerError("store_qr_ciphertext_integrity_failed");
        return error("STORE_QR_UNAVAILABLE", 503);
      }

      return NextResponse.json({
        ok: true,
        store: manager,
        token: { issuedAt: active[0].created_at },
        ...(await renderQr(rawToken)),
      });
    }

    if (action === "REVOKE") {
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
    const tokenHash = hashStoreEntryToken(rawToken);
    if (!tokenHash) {
      throw new Error("STORE_QR_TOKEN_GENERATION_FAILED");
    }
    const sealedToken = encryptStoreEntryToken(rawToken, managerStoreId);
    const rotation = await sql.transaction((transactionSql) => [
      transactionSql`
        SELECT *
        FROM rotate_store_entry_token(
          ${manager.store_id},
          ${tokenHash}
        )
      `,
      transactionSql`
        UPDATE store_entry_tokens
        SET token_ciphertext = ${sealedToken}
        WHERE store_id = ${manager.store_id}
          AND active = TRUE
          AND revoked_at IS NULL
      `,
    ]);
    const rotated = rotation[0];
    const rendered = await renderQr(rawToken);

    return NextResponse.json({
      ok: true,
      store: manager,
      ...rendered,
      token: {
        id: rotated[0].entry_token_id,
        revokedCount: Number(rotated[0].revoked_count),
      },
      message: "このQRは管理者認証後に打刻用掲示から再表示できます。",
    });
  } catch (caught) {
    if (caught instanceof LineTokenVerificationError) {
      return error("INVALID_ID_TOKEN", 401);
    }
    const message = caught instanceof Error ? caught.message : "";
    if (message.includes("STORE_NOT_ACTIVE")) {
      return error("STORE_NOT_ACTIVE", 409);
    }
    if (message.includes("STORE_QR_ENCRYPTION_KEY")) {
      logServerError("store_qr_encryption_configuration_failed");
      return error("STORE_QR_UNAVAILABLE", 503);
    }
    logServerError("store_qr_operation_failed");
    return error("STORE_QR_UNAVAILABLE", 503);
  }
}
