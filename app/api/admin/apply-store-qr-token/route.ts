import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STORE_ID = "208de0f0-b53a-45d5-b961-0b945656e029";
const TOKEN_HASH =
  "ec3bcea5498d9d34613c40e80b22f6ad6299aadd10f6d9910eed205778effb1d";

export async function GET() {
  try {
    const sql = getSql();

    const store = await sql`
      SELECT id, name
      FROM stores
      WHERE id = ${STORE_ID}::uuid
        AND status = 'active'
      LIMIT 1
    `;

    if (store.length !== 1) {
      return NextResponse.json(
        { ok: false, status: "not_applied", reason: "store_not_found" },
        { status: 404 },
      );
    }

    const existing = await sql`
      SELECT id, store_id, active
      FROM store_entry_tokens
      WHERE token_hash = ${TOKEN_HASH}
      LIMIT 1
    `;

    if (existing.length === 1) {
      return NextResponse.json({
        ok: true,
        status: "already_applied",
        token: existing[0],
      });
    }

    const inserted = await sql`
      INSERT INTO store_entry_tokens (store_id, token_hash)
      VALUES (${STORE_ID}::uuid, ${TOKEN_HASH})
      RETURNING id, store_id, active, expires_at, created_at
    `;

    return NextResponse.json({
      ok: true,
      status: "applied",
      token: inserted[0],
    });
  } catch (error) {
    console.error("Store QR token setup failed", error);

    return NextResponse.json(
      { ok: false, status: "not_applied", reason: "setup_failed" },
      { status: 503 },
    );
  }
}
