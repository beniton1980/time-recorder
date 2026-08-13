import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sql = getSql();
    const rows = await sql`SELECT NOW() AS database_time`;
    const databaseTime = rows[0]?.database_time;

    return NextResponse.json({
      ok: true,
      database: "connected",
      databaseTime,
    });
  } catch {
    logServerError("database_health_check_failed");

    return NextResponse.json(
      {
        ok: false,
        database: "unavailable",
      },
      { status: 503 },
    );
  }
}
