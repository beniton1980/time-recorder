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
  const apiKey = process.env.RESEND_API_KEY;
  const domain = process.env.RESEND_EMAIL_DOMAIN;

  if (!apiKey || !domain) {
    return { sent: false, code: "EMAIL_NOT_CONFIGURED" };
  }

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
      subject: `【ONOGAMI 勤怠】${mail.storeName} 店舗QR発行完了`,
      html: `<p>${escapeHtml(mail.managerName)} 様</p>
        <p>${escapeHtml(mail.storeName)}の管理者登録と店舗QRの発行が完了しました。</p>
        <p>添付のPNG画像を保存し、スタッフが読み取れる場所へ掲示してください。</p>
        <p><a href="${escapeHtml(mail.managerUrl)}">LINEで店舗QR管理を開く</a></p>
        <p>QRを再発行すると、以前のQRは利用できなくなります。</p>`,
      attachments: [{
        filename: `${safeFileName(mail.storeName)}-打刻QR.png`,
        content: pngBase64(mail.qrPngDataUrl),
        content_type: "image/png",
      }],
    }),
    signal: AbortSignal.timeout(10_000),
  });

  return response.ok
    ? { sent: true }
    : { sent: false, code: "EMAIL_DELIVERY_FAILED" };
}
