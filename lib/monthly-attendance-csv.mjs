function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function duration(minutes) {
  if (minutes === null || minutes === undefined) return "";
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function dailyEventDetails(staff, businessDate) {
  return staff.events
    .filter((event) => event.businessDate === businessDate)
    .map((event) => `${event.time} ${event.label}`)
    .join(" / ");
}

const reasonLabels = {
  UNCLOSED_SHIFT: "退勤の打刻がありません",
  UNCLOSED_BREAK: "休憩終了の打刻がありません",
  PENDING_CORRECTION: "未処理の修正申請があります",
  LOGICAL_CONTRADICTION: "打刻順序を確認してください",
  MISSING_DAILY_ATTENDANCE: "日別勤怠を確定できません",
  UNUSUALLY_LONG_BREAK: "勤務時間に対して休憩時間が長くなっています。打刻内容をご確認ください",
  UNUSUALLY_LONG_WORK: "勤務時間が長くなっています。打刻内容をご確認ください",
};

export function createMonthlyAttendanceCsv(report) {
  if (!report?.storeName || !Array.isArray(report.staff)) {
    throw new TypeError("Invalid monthly attendance report");
  }
  const lines = [[
    "営業日",
    "スタッフ名",
    "休憩合計",
    "実働",
    "深夜",
    "状態",
    "備考",
    "打刻詳細",
  ].map(csvCell).join(",")];

  for (const staff of report.staff) {
    for (const day of staff.dailyAttendance) {
      const notes = [
        day.hasCorrection ? "訂正あり" : "",
        day.gpsIssueCount > 0 ? `GPS確認${day.gpsIssueCount}件` : "",
        ...[...(day.attendanceReasons ?? []), ...(day.reviewReasons ?? [])]
          .map((reason) => reasonLabels[reason] ?? reason),
      ].filter(Boolean).join(" / ");
      lines.push([
        day.businessDate,
        staff.name,
        duration(day.breakMinutes),
        duration(day.workedMinutes),
        duration(day.lateNightMinutes),
        (day.attendanceReasons?.length || day.reviewReasons?.length) ? "要確認" : "確定",
        notes,
        dailyEventDetails(staff, day.businessDate),
      ].map(csvCell).join(","));
    }
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
