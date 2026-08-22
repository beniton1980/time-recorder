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

const attendanceReasonLabels = {
  UNCLOSED_SHIFT: "退勤の打刻がありません",
  UNCLOSED_BREAK: "休憩終了の打刻がありません",
  PENDING_CORRECTION: "未処理の修正申請があります",
  LOGICAL_CONTRADICTION: "打刻順序を確認してください",
  MISSING_DAILY_ATTENDANCE: "日別勤怠を確定できません",
};

function issueList(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return "";
  const items = issues.map((issue) => {
    const reason = (issue.reasons ?? []).map((value) => attendanceReasonLabels[value] ?? value).join(" / ");
    return `<li>${escapeHtml(issue.staffName)}　${escapeHtml(issue.businessDate)}　${escapeHtml(reason)}</li>`;
  }).join("");
  return `<p>確認が必要な項目：</p><ul>${items}</ul>`;
}

export function createMonthlyAttendanceEmail(mail) {
  const needsAttendanceReview = mail.attendanceIssueDays > 0;
  const needsGpsReview = mail.gpsIssueCount > 0;
  const statusPrefix = needsAttendanceReview
    ? `【要確認${mail.attendanceIssueDays}件】`
    : needsGpsReview
      ? `【GPS確認${mail.gpsIssueCount}件】`
      : "【確認事項なし】";
  const acceptancePrefix = mail.acceptanceTest === true ? "【受入テスト】" : "";
  const subject = `${acceptancePrefix}${statusPrefix}【ONOGAMI勤怠】${mail.storeName} ${mail.label}の勤怠がまとまりました`;
  const summary = mail.staffCount === 0
    ? "今回の締め期間には勤怠記録がありませんでした。"
    : needsAttendanceReview
      ? `確認が必要な勤怠が${mail.attendanceIssueDays}件あります。`
      : needsGpsReview
        ? `勤怠時間は確定していますが、GPS確認が${mail.gpsIssueCount}件あります。`
      : "要確認事項はありません。添付PDFをご確認ください。";
  const acceptanceNotice = mail.acceptanceTest === true
    ? "<p><strong>これは月次勤怠の受入テストです。</strong><br>本番の月次自動送信や配信履歴には影響しません。</p>"
    : "";
  const html = `${acceptanceNotice}<p>${escapeHtml(mail.storeName)}の${escapeHtml(mail.label)}勤怠をお送りします。</p>
    <p>対象期間: ${escapeHtml(mail.period.start)} - ${escapeHtml(mail.period.end)}<br>
    スタッフ: ${mail.staffCount}名<br>
    勤怠要確認: ${mail.attendanceIssueDays}日分<br>
    GPS確認: ${mail.gpsIssueCount}件</p>
    <p>${escapeHtml(summary)}</p>
    ${issueList(mail.attendanceIssues)}
    ${needsAttendanceReview ? "<p>修正後は勤怠表を再発行できます。</p>" : ""}`;
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
