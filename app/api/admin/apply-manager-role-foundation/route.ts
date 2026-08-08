import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INITIAL_MANAGER_STAFF_ID = "d0976e41-3fa0-41fc-95b7-b3c33124aef8";

export async function GET() {
  try {
    const sql = getSql();

    await sql`
      ALTER TABLE staff
        ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'STAFF'
    `;

    await sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'staff_role_check'
            AND conrelid = 'staff'::regclass
        ) THEN
          ALTER TABLE staff
            ADD CONSTRAINT staff_role_check
            CHECK (role IN ('STAFF', 'MANAGER'));
        END IF;
      END
      $$
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_staff_store_role
        ON staff(store_id, role)
    `;

    const managers = await sql`
      UPDATE staff
      SET
        role = 'MANAGER',
        updated_at = NOW()
      WHERE id = ${INITIAL_MANAGER_STAFF_ID}
        AND status = 'active'
      RETURNING id, store_id, legal_name, role
    `;

    if (managers.length !== 1) {
      return NextResponse.json(
        {
          ok: false,
          status: "not_applied",
          reason: "initial_manager_staff_not_found",
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ok: true,
      status: "applied",
      manager: managers[0],
    });
  } catch (error) {
    console.error("Manager role foundation failed", error);

    return NextResponse.json(
      { ok: false, status: "failed" },
      { status: 500 },
    );
  }
}
