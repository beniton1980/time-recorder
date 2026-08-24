import { isEmailDeliveryAllowed } from "@/lib/environment-safety.mjs";

type ManagerInviteMail = {
  requestId: string;
  recipient: string;
  managerName: string;
  storeName: string;
  inviteUrl: string;
  expiresAt: string | Date;
};

export type ManagerInviteMailResult =
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

export async function sendManagerInviteMail(
  mail: ManagerInviteMail,
): Promise<ManagerInviteMailResult> {
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
      "Idempotency-Key": `onboarding-manager-invite-${mail.requestId}`,
    },
    body: JSON.stringify({
      from: `ONOGAMI 勤怠 <no-reply@${domain}>`,
      to: [mail.recipient],
      subject: `【ONOGAMI 勤怠】ご利用開始のご案内（${mail.storeName}）`,
      html: `<p>${escapeHtml(mail.managerName)} 様</p>
        <p>${escapeHtml(mail.storeName)} のご利用準備ができました。</p>
        <p>まず、店舗を管理する方のLINEを登録してください。</p>
        <p><a href="${escapeHtml(mail.inviteUrl)}">LINEで管理者登録を開始する</a></p>
        <p>登録が完了すると、店舗の打刻QRが発行され、管理者画面を利用できるようになります。</p>
        <p>このリンクは、登録するご本人のLINEアカウントで開いてください。</p>
        <p>リンクは${escapeHtml(expiresAt)}まで有効で、1回のみ利用できます。</p>
        <p>お心当たりがない場合は、このメールを破棄してください。</p>`,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  return response.ok
    ? { sent: true }
    : { sent: false, code: "EMAIL_DELIVERY_FAILED" };
}
