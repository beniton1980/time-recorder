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
  UNUSUALLY_LONG_BREAK: "勤務時間に対して休憩時間が長くなっています。打刻内容をご確認ください",
  UNUSUALLY_LONG_WORK: "勤務時間が長くなっています。打刻内容をご確認ください",
};

const weekdays = ["日", "月", "火", "水", "木", "金", "土"];

function japaneseDate(value) {
  const text = String(value ?? "");
  const date = new Date(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(date.valueOf())) return text;
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日(${weekdays[date.getUTCDay()]})`;
}

function issueList(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return "";
  const items = issues.map((issue) => {
    const reason = (issue.reasons ?? []).map((value) => attendanceReasonLabels[value] ?? value).join(" / ");
    return `<li>${escapeHtml(issue.staffName)}　${escapeHtml(japaneseDate(issue.businessDate))}　${escapeHtml(reason)}</li>`;
  }).join("");
  return `<p>確認が必要な項目：</p><ul>${items}</ul>`;
}

function minutesLabel(minutes) {
  const value = Number.isFinite(minutes) ? Math.max(0, Math.trunc(minutes)) : 0;
  return `${Math.floor(value / 60)}時間${String(value % 60).padStart(2, "0")}分`;
}

function staffSummaryTable(staffSummaries) {
  if (!Array.isArray(staffSummaries) || staffSummaries.length === 0) return "";
  const rows = staffSummaries.map((staff) => `<tr>
      <td style="padding:6px 8px;border:1px solid #d8d8d8;">${escapeHtml(staff.name)}</td>
      <td style="padding:6px 8px;border:1px solid #d8d8d8;text-align:center;white-space:nowrap;">${Number(staff.workDays) || 0}日</td>
      <td style="padding:6px 8px;border:1px solid #d8d8d8;text-align:center;white-space:nowrap;">${minutesLabel(staff.workMinutes)}</td>
      <td style="padding:6px 8px;border:1px solid #d8d8d8;text-align:center;white-space:nowrap;">${minutesLabel(staff.lateNightMinutes)}</td>
    </tr>`).join("");
  return `<p><strong>スタッフ別月次サマリー</strong></p>
    <table style="border-collapse:collapse;font-size:14px;">
      <thead><tr style="background:#f4f3ee;">
        <th style="padding:6px 8px;border:1px solid #d8d8d8;text-align:left;">氏名</th>
        <th style="padding:6px 8px;border:1px solid #d8d8d8;">出勤日数</th>
        <th style="padding:6px 8px;border:1px solid #d8d8d8;">実労働合計</th>
        <th style="padding:6px 8px;border:1px solid #d8d8d8;">深夜時間</th>
      </tr></thead><tbody>${rows}</tbody>
    </table>
    <p style="font-size:12px;color:#555;">※実労働時間・深夜時間は、休憩時間を差し引いて集計しています。<br>
    ※FREE版では、出退勤時刻の丸め処理など店舗独自の給与計算ルールは適用していません。</p>`;
}

function gpsIssueList(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return "";
  const items = issues.map((issue) => `<li>${escapeHtml(issue.staffName)}　${escapeHtml(japaneseDate(issue.businessDate))}</li>`).join("");
  return `<p><strong>GPSについて確認する勤務日</strong></p><ul>${items}</ul>
    <p>必要に応じて本人へ確認してください。</p>`;
}

export function createMonthlyAttendanceEmail(mail) {
  const needsAttendanceReview = mail.attendanceIssueDays > 0;
  const gpsIssueDays = Array.isArray(mail.gpsIssues) ? mail.gpsIssues.length : mail.gpsIssueCount;
  const needsGpsReview = gpsIssueDays > 0;
  const statusSuffix = needsAttendanceReview
    ? `（要確認${mail.attendanceIssueDays}日）`
    : needsGpsReview
      ? `（GPS確認${gpsIssueDays}日）`
      : "（確認事項なし）";
  const acceptancePrefix = mail.acceptanceTest === true ? "【受入テスト】" : "";
  const subject = `${acceptancePrefix}【ONOGAMI勤怠】${mail.storeName} ${mail.label}${statusSuffix}`;
  const summary = mail.staffCount === 0
    ? "今回の締め期間には勤怠記録がありませんでした。"
    : needsAttendanceReview
      ? `確認が必要な勤怠が${mail.attendanceIssueDays}件あります。`
      : needsGpsReview
        ? `勤怠時間について確認が必要な項目はありません。GPSについて確認が必要な勤務日が${gpsIssueDays}日あります。`
      : "今月の勤怠に確認が必要な項目はありません。添付の勤怠表を保存してください。";
  const acceptanceNotice = mail.acceptanceTest === true
    ? "<p><strong>これは月次勤怠の受入テストです。</strong><br>本番の月次自動送信や配信履歴には影響しません。</p>"
    : "";
  const html = `${acceptanceNotice}<p>${escapeHtml(mail.storeName)}の${escapeHtml(mail.label)}勤怠をお送りします。</p>
    <p><strong>${escapeHtml(summary)}</strong></p>
    <p>対象期間: ${escapeHtml(japaneseDate(mail.period.start))} - ${escapeHtml(japaneseDate(mail.period.end))}</p>
    ${staffSummaryTable(mail.staffSummaries)}
    ${issueList(mail.attendanceIssues)}
    ${gpsIssueList(mail.gpsIssues)}
    ${needsAttendanceReview ? "<p>修正後は勤怠表を再発行できます。</p>" : ""}
    <p>日ごとの打刻時刻、休憩内訳、訂正履歴などの詳細は、添付PDFでご確認ください。CSVは管理画面から出力できます。</p>`;
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
