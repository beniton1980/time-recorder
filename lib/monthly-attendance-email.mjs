import { isEmailDeliveryAllowed } from "./environment-safety.mjs";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function safeFilename(value) {
  return String(value).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").slice(0, 120);
}

function base64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

export function createMonthlyAttendanceEmail(mail) {
  const needsReview = mail.attendanceIssueDays > 0 || mail.gpsIssueCount > 0;
  const subjectPrefix = needsReview ? "【要確認】" : "";
  const subject = `${subjectPrefix}【ONOGAMI勤怠】${mail.storeName} ${mail.label}の勤怠がまとまりました`;
  const summary = mail.staffCount === 0
    ? "今回の締め期間には勤怠記録がありませんでした。"
    : needsReview
      ? "一部の記録に確認が必要です。添付PDFをご確認ください。"
      : "要確認事項はありません。添付PDFをご確認ください。";
  const html = `<p>${escapeHtml(mail.storeName)}の${escapeHtml(mail.label)}勤怠をお送りします。</p>
    <p>対象期間: ${escapeHtml(mail.period.start)} - ${escapeHtml(mail.period.end)}<br>
    スタッフ: ${mail.staffCount}名<br>
    勤怠要確認: ${mail.attendanceIssueDays}日分<br>
    GPS確認: ${mail.gpsIssueCount}件</p>
    <p>${escapeHtml(summary)}</p>
    ${needsReview ? "<p>修正後は勤怠表を再発行できます。</p>" : ""}`;
  return { subject, html };
}

export async function sendMonthlyAttendanceEmail(mail, options = {}) {
  if (!isEmailDeliveryAllowed()) {
    return { sent: false, code: "EMAIL_NOT_CONFIGURED" };
  }
  const apiKey = options.apiKey ?? process.env.RESEND_API_KEY;
  const domain = options.domain ?? process.env.RESEND_EMAIL_DOMAIN;
  if (!apiKey || !domain) return { sent: false, code: "EMAIL_NOT_CONFIGURED" };
  if (!(mail.pdf instanceof Uint8Array) || mail.pdf.length === 0) {
    return { sent: false, code: "PDF_REQUIRED" };
  }
  const { subject, html } = createMonthlyAttendanceEmail(mail);
  const fetchImpl = options.fetchImpl ?? fetch;
  let response;
  try {
    response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `monthly-attendance-${mail.storeId}-${mail.period.start}-${mail.period.end}-${mail.deliveryVersion}`,
      },
      body: JSON.stringify({
        from: `ONOGAMI 勤怠 <no-reply@${domain}>`,
        to: [mail.recipient],
        subject,
        html,
        attachments: [{
          filename: safeFilename(`${mail.storeName}-${mail.label}-勤怠表.pdf`),
          content: base64(mail.pdf),
        }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { sent: false, code: "EMAIL_DELIVERY_FAILED" };
  }
  if (!response.ok) return { sent: false, code: "EMAIL_DELIVERY_FAILED" };
  const result = await response.json().catch(() => ({}));
  return { sent: true, emailId: typeof result.id === "string" ? result.id : null };
}
