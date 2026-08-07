import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const testLineUserId = "test-line-user-v2";

export async function GET() {
  const sql = getSql();

  const existing = await sql`
    SELECT id
    FROM staff
    WHERE line_user_id = ${testLineUserId}
    LIMIT 1
  `;

  if (existing.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        status: "not_applied",
        reason: "test_staff_already_exists",
      },
      { status: 409 },
    );
  }

  await sql`
    WITH new_store AS (
      INSERT INTO stores (
        name,
        timezone,
        business_day_start_minute,
        closing_rule,
        status
      )
      VALUES (
        'テスト店舗（削除可）',
        'Asia/Tokyo',
        300,
        'month_end',
        'active'
      )
      RETURNING id
    ),
    new_staff AS (
      INSERT INTO staff (
        store_id,
        line_user_id,
        legal_name,
        status
      )
      SELECT
        id,
        ${testLineUserId},
        'テスト スタッフ',
        'active'
      FROM new_store
      RETURNING id
    )
    INSERT INTO staff_states (
      staff_id,
      state
    )
    SELECT
      id,
      'OFF_DUTY'
    FROM new_staff
  `;

  const records = await sql`
    SELECT
      s.id AS store_id,
      s.name AS store_name,
      st.id AS staff_id,
      st.legal_name,
      ss.state
    FROM stores s
    JOIN staff st ON st.store_id = s.id
    JOIN staff_states ss ON ss.staff_id = st.id
    WHERE st.line_user_id = ${testLineUserId}
  `;

  return NextResponse.json({
    ok: true,
    status: "applied",
    record: records[0],
  });
}
