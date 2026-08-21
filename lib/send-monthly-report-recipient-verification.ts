import { isEmailDeliveryAllowed } from "@/lib/environment-safety.mjs";

type VerificationMail = {
  storeId: string;
  storeName: string;
  recipient: string;
  verificationUrl: string;
  expiresAt: string | Date;
  deliveryKey: string;
};

export type VerificationMailResult =
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

export async function sendMonthlyReportRecipientVerification(
  mail: VerificationMail,
): Promise<VerificationMailResult> {
  if (!isEmailDeliveryAllowed()) {
    return { sent: false, code: "EMAIL_NOT_CONFIGURED" };
  }
  const apiKey = process.env.RESEND_API_KEY;
  const domain = process.env.RESEND_EMAIL_DOMAIN;
  if (!apiKey || !domain) {
    return { sent: false, code: "EMAIL_NOT_CONFIGURED" };
  }

  const expiresAt = new Date(mail.expiresAt).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
  });
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `monthly-report-recipient-${mail.storeId}-${mail.deliveryKey}`,
    },
    body: JSON.stringify({
      from: `ONOGAMI 勤怠 <no-reply@${domain}>`,
      to: [mail.recipient],
      subject: `【ONOGAMI 勤怠】${mail.storeName} 月次勤怠表の送信先確認`,
      html: `<p>${escapeHtml(mail.storeName)}の月次勤怠表の送信先を確認します。</p>
        <p>月次勤怠表にはスタッフ氏名、打刻時刻、勤務・休憩時間、勤怠の要確認状態が含まれます。</p>
        <p><a href="${escapeHtml(mail.verificationUrl)}">送信先を確認し、月次勤怠表の受信に同意する</a></p>
        <p>確認と同意が完了するまで月次勤怠表は送信されません。</p>
        <p>このリンクは${escapeHtml(expiresAt)}まで有効です。</p>
        <p>心当たりがない場合は、このメールを破棄してください。</p>`,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  return response.ok
    ? { sent: true }
    : { sent: false, code: "EMAIL_DELIVERY_FAILED" };
}
