import { isEmailDeliveryAllowed } from "@/lib/environment-safety.mjs";

type ContactEmailVerificationMail = {
  requestId: string;
  recipient: string;
  managerName: string;
  storeName: string;
  verificationUrl: string;
  expiresAt: string | Date;
  deliveryKey: string;
};

export type ContactEmailVerificationMailResult =
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

export async function sendContactEmailVerificationMail(
  mail: ContactEmailVerificationMail,
): Promise<ContactEmailVerificationMailResult> {
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
      "Idempotency-Key": `onboarding-contact-email-${mail.requestId}-${mail.deliveryKey}`,
    },
    body: JSON.stringify({
      from: `ONOGAMI 勤怠 <no-reply@${domain}>`,
      to: [mail.recipient],
      subject: `【ONOGAMI 勤怠】${mail.storeName} メールアドレス確認`,
      html: `<p>${escapeHtml(mail.managerName)} 様</p>
        <p>${escapeHtml(mail.storeName)}の連絡先メールアドレスを確認します。</p>
        <p><a href="${escapeHtml(mail.verificationUrl)}">メールアドレスを確認する</a></p>
        <p>確認が完了するまで、管理者招待や店舗QRは発行されません。</p>
        <p>このリンクは${escapeHtml(expiresAt)}まで有効です。</p>
        <p>心当たりがない場合は、このメールを破棄してください。</p>`,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  return response.ok
    ? { sent: true }
    : { sent: false, code: "EMAIL_DELIVERY_FAILED" };
}
