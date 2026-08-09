import { getSql } from "@/lib/db";
import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { idToken?: unknown; month?: unknown };

const eventLabels: Record<string, string> = {
  CHECK_IN: "出勤",
  BREAK_START: "休憩開始",
  BREAK_END: "休憩終了",
  CHECK_OUT: "退勤",
};

function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json() as Body;
  } catch {
    return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 });
  }

  if (
    typeof body.idToken !== "string" ||
    typeof body.month !== "string" ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.month)
  ) {
    return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const identity = await verifyLineIdToken(body.idToken);
    const sql = getSql();
    const managers = await sql`
      SELECT st.store_id, s.name AS store_name, s.timezone
      FROM staff st
      JOIN stores s ON s.id = st.store_id
      WHERE st.line_user_id = ${identity.sub}
        AND st.status = 'active'
        AND st.role = 'MANAGER'
        AND s.status = 'active'
      ORDER BY st.created_at ASC
      LIMIT 1
    `;

    if (managers.length === 0) {
      return Response.json({ ok: false, code: "MANAGER_ACCESS_REQUIRED" }, { status: 403 });
    }

    const manager = managers[0];
    const rows = await sql`
      SELECT
        epe.business_date::text AS business_date,
        st.legal_name,
        epe.event_type,
        to_char(
          epe.occurred_at AT TIME ZONE ${manager.timezone},
          'YYYY-MM-DD HH24:MI:SS'
        ) AS occurred_at_local,
        epe.corrected
      FROM effective_punch_events epe
      JOIN staff st ON st.id = epe.staff_id
      WHERE epe.store_id = ${manager.store_id}
        AND epe.business_date >= (${body.month} || '-01')::date
        AND epe.business_date < ((${body.month} || '-01')::date + INTERVAL '1 month')
      ORDER BY epe.business_date ASC, st.legal_name ASC,
        epe.occurred_at ASC, epe.effective_id ASC
    `;

    if (rows.length === 0) {
      return Response.json({ ok: false, code: "NO_ATTENDANCE_RECORDS" }, { status: 404 });
    }

    const lines = [
      ["営業日", "スタッフ名", "打刻種類", "打刻日時", "訂正"].map(csvCell).join(","),
      ...rows.map((row) => [
        row.business_date,
        row.legal_name,
        eventLabels[String(row.event_type)] ?? row.event_type,
        row.occurred_at_local,
        row.corrected ? "訂正あり" : "",
      ].map(csvCell).join(",")),
    ];
    const filename = encodeURIComponent(`${manager.store_name}-${body.month}-勤怠.csv`);

    return new Response(`\uFEFF${lines.join("\r\n")}\r\n`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="attendance-${body.month}.csv"; filename*=UTF-8''${filename}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (caught) {
    if (caught instanceof LineTokenVerificationError) {
      return Response.json({ ok: false, code: "INVALID_ID_TOKEN" }, { status: 401 });
    }
    console.error("Attendance export failed", caught);
    return Response.json({ ok: false, code: "ATTENDANCE_EXPORT_UNAVAILABLE" }, { status: 503 });
  }
}

