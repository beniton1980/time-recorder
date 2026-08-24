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
  const safeStoreName = safeFileName(mail.storeName);

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
      subject: `【ONOGAMI 勤怠】ご利用開始のご案内｜店舗QRと掲示用チラシ（${mail.storeName}）`,
      html: `<p>${escapeHtml(mail.managerName)} 様</p>
        <p>${escapeHtml(mail.storeName)} の管理者登録が完了し、ONOGAMI勤怠を利用開始できる状態になりました。</p>
        <p><strong>このメールには「店舗打刻QR画像」と「掲示用チラシ（印刷用PDF）」を添付しています。</strong></p>
        <p><strong>まず行っていただくこと</strong><br>
        1. 掲示用チラシを印刷する<br>
        2. スタッフが見やすい場所に貼る<br>
        3. 必要に応じて管理者画面を開く</p>
        <p>スタッフは掲示されたQRを読み取り、初回のみ氏名を入力します。その後は「出勤」「休憩開始」「休憩終了」「退勤」のボタンで打刻できます。</p>
        <p>管理者画面では、スタッフの勤怠確認、打刻修正申請への対応、スタッフ管理、QRの再発行などを行えます。</p>
        <p><a href="${escapeHtml(mail.managerUrl)}">LINEで管理者画面を開く</a></p>
        <p>QRを再発行すると、以前のQRは利用できなくなります。</p>
        <p>締め日後には、月次の勤怠データをメールでお送りします。</p>`,
      attachments: [
        {
          filename: `${safeStoreName}-打刻QR.png`,
          content: pngBase64(mail.qrPngDataUrl),
          content_type: "image/png",
        },
        {
          filename: `${safeStoreName}-打刻案内.pdf`,
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
