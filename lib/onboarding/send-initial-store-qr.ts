import { isEmailDeliveryAllowed } from "@/lib/environment-safety.mjs";
import { generateStorePosterPdf } from "@/lib/onboarding/store-poster.mjs";

type InitialStoreQrMail = {
  requestId: string;
  recipient: string;
  managerName: string;
  storeName: string;
  qrPngDataUrl: string;
  managerUrl: string;
};

export type InitialStoreQrMailResult =
  | { sent: true }
  | { sent: false; code: "EMAIL_NOT_CONFIGURED" | "EMAIL_DELIVERY_FAILED" };

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function safeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "-");
}

function pngBase64(dataUrl: string) {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) {
    throw new Error("INVALID_QR_PNG");
  }
  return dataUrl.slice(prefix.length);
}

export async function sendInitialStoreQrMail(
  mail: InitialStoreQrMail,
): Promise<InitialStoreQrMailResult> {
  if (!isEmailDeliveryAllowed()) {
    return { sent: false, code: "EMAIL_NOT_CONFIGURED" };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const domain = process.env.RESEND_EMAIL_DOMAIN;

  if (!apiKey || !domain) {
    return { sent: false, code: "EMAIL_NOT_CONFIGURED" };
  }

  const posterPdf = await generateStorePosterPdf({
    storeName: mail.storeName,
    qrPngDataUrl: mail.qrPngDataUrl,
  });

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `onboarding-store-qr-${mail.requestId}`,
    },
    body: JSON.stringify({
      from: `ONOGAMI 勤怠 <no-reply@${domain}>`,
      to: [mail.recipient],
      subject: `【ONOGAMI勤怠】ご利用開始のご案内｜店舗QRと掲示用チラシをお送りします（${mail.storeName}）`,
      html: `<p>${escapeHtml(mail.managerName)} 様</p>
        <p>${escapeHtml(mail.storeName)} の管理者登録が完了し、<strong>ONOGAMI勤怠を利用開始できる状態になりました。</strong></p>
        <p>このメールには、以下を添付しています。</p>
        <ul><li>店舗打刻QR画像</li><li>掲示用チラシ（印刷用PDF）</li></ul>
        <p><strong>まず行っていただくこと</strong></p>
        <ol><li>掲示用チラシを印刷する</li><li>スタッフが見やすい場所に貼る</li><li>必要に応じて管理者画面を開く</li></ol>
        <p>スタッフは、掲示されたQRを読み取ることで打刻できます。初回のみ氏名を入力し、その後は「出勤」「休憩開始」「休憩終了」「退勤」を押して利用します。</p>
        <p>管理者画面では、スタッフの勤怠確認、打刻修正申請の承認、スタッフ管理、QRの再発行ができます。</p>
        <p><a href="${escapeHtml(mail.managerUrl)}">LINEで管理者画面を開く</a></p>
        <p>※QRを再発行すると、以前のQRは利用できなくなります。<br>※締め日後には、月次の勤怠データをメールでお送りします。</p>`,
      attachments: [
        {
          filename: `${safeFileName(mail.storeName)}-打刻QR.png`,
          content: pngBase64(mail.qrPngDataUrl),
          content_type: "image/png",
        },
        {
          filename: `${safeFileName(mail.storeName)}-掲示用チラシ.pdf`,
          content: posterPdf.toString("base64"),
          content_type: "application/pdf",
        },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });

  return response.ok
    ? { sent: true }
    : { sent: false, code: "EMAIL_DELIVERY_FAILED" };
}
