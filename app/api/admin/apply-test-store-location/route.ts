import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEST_STORE_ID = "208de0f0-b53a-45d5-b961-0b945656e029";
const TEST_STORE_NAME = "テスト店舗（削除可）";
const LATITUDE = 34.851117;
const LONGITUDE = 138.251342;

export async function GET() {
  try {
    const sql = getSql();

    const updated = await sql`
      UPDATE stores
      SET
        latitude = ${LATITUDE},
        longitude = ${LONGITUDE},
        updated_at = NOW()
      WHERE id = ${TEST_STORE_ID}
        AND name = ${TEST_STORE_NAME}
        AND latitude IS NULL
        AND longitude IS NULL
      RETURNING id, name, latitude, longitude
    `;

    if (updated.length === 1) {
      return NextResponse.json({
        ok: true,
        status: "applied",
        store: updated[0],
      });
    }

    const current = await sql`
      SELECT id, name, latitude, longitude
      FROM stores
      WHERE id = ${TEST_STORE_ID}
        AND name = ${TEST_STORE_NAME}
      LIMIT 1
    `;

    if (
      current.length === 1 &&
      Number(current[0].latitude) === LATITUDE &&
      Number(current[0].longitude) === LONGITUDE
    ) {
      return NextResponse.json({
        ok: true,
        status: "already_applied",
        store: current[0],
      });
    }

    return NextResponse.json(
      {
        ok: false,
        status: "not_applied",
        reason:
          current.length === 0
            ? "test_store_not_found"
            : "store_location_already_set",
      },
      { status: 409 },
    );
  } catch (error) {
    console.error("Test store location setup failed", error);

    return NextResponse.json(
      { ok: false, status: "unavailable" },
      { status: 503 },
    );
  }
}
