import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sql = getSql();

    const current = await sql`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'correction_requests'::regclass
        AND conname = 'correction_requests_operation_check'
      LIMIT 1
    `;

    if (
      current.length === 1 &&
      String(current[0].definition).includes("'REVIEW'")
    ) {
      return NextResponse.json({ ok: true, status: "already_applied" });
    }

    await sql`
      ALTER TABLE correction_requests
      DROP CONSTRAINT correction_requests_operation_check
    `;

    await sql`
      ALTER TABLE correction_requests
      ADD CONSTRAINT correction_requests_operation_check
      CHECK (operation IN ('ADD', 'REPLACE', 'VOID', 'REVIEW'))
    `;

    return NextResponse.json({ ok: true, status: "applied" });
  } catch (error) {
    console.error("Correction operation migration failed", error);

    return NextResponse.json(
      { ok: false, status: "not_applied", reason: "migration_failed" },
      { status: 503 },
    );
  }
}
