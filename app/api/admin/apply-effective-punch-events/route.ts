import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { createEffectivePunchEventsView } from "@/lib/db/create-effective-punch-events-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sql = getSql();

    const existing = await sql`
      SELECT 1
      FROM information_schema.views
      WHERE table_schema = 'public'
        AND table_name = 'effective_punch_events'
      LIMIT 1
    `;

    if (existing.length === 1) {
      const summary = await sql`
        SELECT
          COUNT(*)::integer AS effective_events,
          COUNT(*) FILTER (WHERE corrected)::integer AS corrected_events
        FROM effective_punch_events
      `;

      return NextResponse.json({
        ok: true,
        status: "already_applied",
        summary: summary[0],
      });
    }

    await createEffectivePunchEventsView();

    const summary = await sql`
      SELECT
        COUNT(*)::integer AS effective_events,
        COUNT(*) FILTER (WHERE corrected)::integer AS corrected_events
      FROM effective_punch_events
    `;

    return NextResponse.json({
      ok: true,
      status: "applied",
      summary: summary[0],
    });
  } catch (error) {
    console.error("Effective punch events migration failed", error);

    return NextResponse.json(
      { ok: false, status: "not_applied", reason: "migration_failed" },
      { status: 503 },
    );
  }
}
