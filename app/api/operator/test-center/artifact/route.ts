import { verifyOperator, OperatorAccessError, operatorErrorResponse } from "@/lib/onboarding/verify-operator";
import { buildTestCenterScenario } from "@/lib/test-center/scenario.mjs";
import { generateMonthlyAttendancePdf } from "@/lib/monthly-attendance-pdf.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { idToken?: unknown; type?: unknown };
  try { body = await request.json(); }
  catch { return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  try {
    await verifyOperator(body.idToken);
    const scenario = buildTestCenterScenario();
    if (body.type === "email") return Response.json({ ok: true, type: "email", ...scenario.email });
    if (body.type === "csv") return new Response(scenario.csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "inline; filename=onogami-test-center.csv" } });
    if (body.type === "pdf") {
      const pdf = await generateMonthlyAttendancePdf(scenario.report as never);
      return new Response(Buffer.from(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=onogami-test-center.pdf" } });
    }
    return Response.json({ ok: false, code: "INVALID_ARTIFACT_TYPE" }, { status: 400 });
  } catch (error) {
    if (error instanceof OperatorAccessError) {
      const response = operatorErrorResponse(error);
      return Response.json(response.body, { status: response.status });
    }
    return Response.json({ ok: false, code: "ARTIFACT_PREVIEW_FAILED" }, { status: 503 });
  }
}
