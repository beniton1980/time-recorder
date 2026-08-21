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
        ...day.attendanceReasons,
      ].filter(Boolean).join(" / ");
      lines.push([
        day.businessDate,
        staff.name,
        duration(day.breakMinutes),
        duration(day.workedMinutes),
        duration(day.lateNightMinutes),
        day.status === "CONFIRMED" ? "確定" : "要確認",
        notes,
        dailyEventDetails(staff, day.businessDate),
      ].map(csvCell).join(","));
    }
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
