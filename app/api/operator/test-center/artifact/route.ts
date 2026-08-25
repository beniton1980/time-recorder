import { verifyOperator, OperatorAccessError, operatorErrorResponse } from "@/lib/onboarding/verify-operator";
import { buildTestCenterScenario } from "@/lib/test-center/scenario.mjs";
import { generateMonthlyAttendancePdf } from "@/lib/monthly-attendance-pdf.mjs";
import { createContactEmailVerificationMail } from "@/lib/onboarding/send-contact-email-verification";
import { createManagerInviteMail } from "@/lib/onboarding/send-manager-invite";
import { createInitialStoreQrMail } from "@/lib/onboarding/send-initial-store-qr";
import { generateStorePosterPdf } from "@/lib/onboarding/store-poster.mjs";
import QRCode from "qrcode";

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
    const sample = {
      requestId: "00000000-0000-4000-8000-000000000001",
      recipient: "preview@example.invalid",
      managerName: "小野上 太郎",
      storeName: "ONOGAMIテスト店舗",
    };
    if (body.type === "onboarding-contact") return Response.json({ ok: true, type: body.type, ...createContactEmailVerificationMail({
      ...sample, verificationUrl: "https://kintai.onogami.jp/onboarding/verify-email?token=PREVIEW", expiresAt: "2026-09-01T09:00:00+09:00", deliveryKey: "preview",
    }) });
    if (body.type === "onboarding-manager") return Response.json({ ok: true, type: body.type, ...createManagerInviteMail({
      ...sample, inviteUrl: "https://liff.line.me/2010761826-6FNSE1PD?invite=PREVIEW", expiresAt: "2026-09-01T09:00:00+09:00",
    }) });
    if (body.type === "onboarding-start") return Response.json({ ok: true, type: body.type, ...createInitialStoreQrMail({
      ...sample, qrPngDataUrl: "data:image/png;base64,PREVIEW", managerUrl: "https://liff.line.me/2010761826-6FNSE1PD/manager?store_id=00000000-0000-4000-8000-000000000001",
    }), attachments: ["店舗打刻QR画像", "掲示用チラシ（印刷用PDF）"] });
    if (body.type === "onboarding-poster") {
      const qrPngDataUrl = await QRCode.toDataURL("https://liff.line.me/2010761826-6FNSE1PD?store=PREVIEW", { width: 480, margin: 2 });
      const poster = await generateStorePosterPdf({ storeName: sample.storeName, qrPngDataUrl });
      return new Response(new Uint8Array(poster), { headers: { "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=onogami-test-store-poster.pdf" } });
    }
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
