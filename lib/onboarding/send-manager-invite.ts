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
      subject: `【ONOGAMI 勤怠】${mail.storeName} 管理者登録のご案内`,
      html: `<p>${escapeHtml(mail.managerName)} 様</p>
        <p>${escapeHtml(mail.storeName)}の管理者登録をご案内します。</p>
        <p><a href="${escapeHtml(mail.inviteUrl)}">LINEで管理者登録を開始する</a></p>
        <p>スマートフォンでこのリンクを開くとLINEが起動します。登録する管理者本人のLINEアカウントで続けてください。</p>
        <p>このリンクは${escapeHtml(expiresAt)}まで有効で、一度だけ利用できます。</p>
        <p>心当たりがない場合は、このメールを破棄してください。</p>`,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  return response.ok
    ? { sent: true }
    : { sent: false, code: "EMAIL_DELIVERY_FAILED" };
}
