import path from "node:path";
import PDFDocument from "pdfkit";

const NOTO_REGULAR = path.join(process.cwd(), "assets", "fonts", "NotoSansJP-Regular.otf");
const NOTO_BOLD = path.join(process.cwd(), "assets", "fonts", "NotoSansJP-Bold.otf");

const PAGE_WIDTH = 841.89;
const PAGE_HEIGHT = 595.28;
const MARGIN = 31;
const NAVY = "#20334f";
const TEXT = "#202020";
const MUTED = "#5c6b80";
const BEIGE = "#faf9f5";
const LIGHT_BEIGE = "#f4f3ee";
const FLAG_BG = "#fbf1e7";

function text(doc, x, y, value, size = 10, color = TEXT, bold = false, options = {}) {
  const { width, align = "left", characterSpacing = 0 } = options;
  doc.save()
    .font(bold ? "NotoSansJP-Bold" : "NotoSansJP-Regular")
    .fontSize(size)
    .fillColor(color)
    .text(String(value ?? ""), x, PAGE_HEIGHT - y - size * 0.92, {
      lineBreak: false,
      ...(width ? { width, align } : {}),
      characterSpacing,
    })
    .restore();
}

function cellText(doc, x, bottom, width, height, value, size = 10, color = TEXT, bold = false, align = "center", padding = 3) {
  const content = String(value ?? "");
  if (!content) return;
  const font = bold ? "NotoSansJP-Bold" : "NotoSansJP-Regular";
  doc.save().font(font).fontSize(size).fillColor(color);
  const lineHeight = doc.currentLineHeight();
  const top = PAGE_HEIGHT - bottom - height;
  doc.text(content, x + padding, top + (height - lineHeight) / 2 - 0.35, {
    width: Math.max(0, width - padding * 2),
    align,
    lineBreak: false,
  });
  doc.restore();
}

function cellLines(doc, x, bottom, width, height, values, size = 10, color = TEXT, bold = false, align = "left", padding = 4) {
  const lines = values.length ? values : [""];
  const font = bold ? "NotoSansJP-Bold" : "NotoSansJP-Regular";
  doc.save().font(font).fontSize(size).fillColor(color);
  const lineHeight = doc.currentLineHeight() * 1.12;
  const top = PAGE_HEIGHT - bottom - height + (height - lineHeight * lines.length) / 2 - 0.35;
  lines.forEach((value, index) => {
    doc.text(String(value ?? ""), x + padding, top + index * lineHeight, {
      width: Math.max(0, width - padding * 2),
      align,
      lineBreak: false,
    });
  });
  doc.restore();
}

function inlineText(doc, x, y, segments, size, color) {
  let cursorX = x;
  for (const segment of segments) {
    text(doc, cursorX, y, segment.value, size, color, Boolean(segment.bold));
    doc.save().font(segment.bold ? "NotoSansJP-Bold" : "NotoSansJP-Regular").fontSize(size);
    cursorX += doc.widthOfString(segment.value);
    doc.restore();
  }
}

function fitText(doc, x, y, value, maxWidth, maxSize, minSize, color = TEXT, bold = false) {
  const font = bold ? "NotoSansJP-Bold" : "NotoSansJP-Regular";
  let size = maxSize;
  doc.save().font(font);
  while (size > minSize) {
    doc.fontSize(size);
    if (doc.widthOfString(String(value ?? "")) <= maxWidth) break;
    size -= 0.25;
  }
  doc.restore();
  text(doc, x, y, value, size, color, bold, { width: maxWidth });
}

function line(doc, x1, y1, x2, y2, color = "#454545", width = 0.6) {
  doc.save().lineWidth(width).strokeColor(color)
    .moveTo(x1, PAGE_HEIGHT - y1).lineTo(x2, PAGE_HEIGHT - y2).stroke().restore();
}

function dashedLine(doc, x1, y1, x2, y2, color = "#cccccc", width = 0.5) {
  doc.save().lineWidth(width).strokeColor(color).dash(3, { space: 2 })
    .moveTo(x1, PAGE_HEIGHT - y1).lineTo(x2, PAGE_HEIGHT - y2).stroke().undash().restore();
}

function fill(doc, x, y, width, height, color) {
  doc.save().fillColor(color).rect(x, PAGE_HEIGHT - y - height, width, height).fill().restore();
}

function roundedFill(doc, x, y, width, height, radius, color) {
  doc.save().fillColor(color).roundedRect(x, PAGE_HEIGHT - y - height, width, height, radius).fill().restore();
}

function rect(doc, x, y, width, height, color = "#454545", strokeWidth = 0.6) {
  doc.save().lineWidth(strokeWidth).strokeColor(color)
    .rect(x, PAGE_HEIGHT - y - height, width, height).stroke().restore();
}

function duration(minutes) {
  if (minutes === null || minutes === undefined) return "";
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function longDuration(minutes) {
  if (minutes === null || minutes === undefined) return "";
  return `${Math.floor(minutes / 60)}時間${String(minutes % 60).padStart(2, "0")}分`;
}

function calendarDates(period) {
  const dates = [];
  const current = new Date(`${period.start}T00:00:00Z`);
  const end = new Date(`${period.end}T00:00:00Z`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

const weekdays = ["日", "月", "火", "水", "木", "金", "土"];

function displayDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return `${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日(${weekdays[date.getUTCDay()]})`;
}

function displayPeriod(period) {
  const start = new Date(`${period.start}T00:00:00Z`);
  const end = new Date(`${period.end}T00:00:00Z`);
  const startText = `${start.getUTCFullYear()}年${start.getUTCMonth() + 1}月${start.getUTCDate()}日`;
  const endText = start.getUTCFullYear() === end.getUTCFullYear()
    ? `${end.getUTCMonth() + 1}月${end.getUTCDate()}日`
    : `${end.getUTCFullYear()}年${end.getUTCMonth() + 1}月${end.getUTCDate()}日`;
  return `${startText} - ${endText}`;
}

function notes(day) {
  if (!day) return "";
  return [
    (day.attendanceReasons?.length || day.reviewReasons?.length) ? "要確認" : "",
    day.gpsIssueCount ? "GPS確認" : "",
    day.hasCorrection ? "訂正あり" : "",
  ].filter(Boolean).join(" / ");
}

const reviewReasonLabels = {
  UNCLOSED_BREAK: "休憩終了の打刻がありません",
  UNCLOSED_SHIFT: "退勤の打刻がありません",
  PENDING_CORRECTION: "未処理の修正申請があります",
  LOGICAL_CONTRADICTION: "打刻順序を確認してください",
  MISSING_DAILY_ATTENDANCE: "日別勤怠を確定できません",
  UNUSUALLY_LONG_BREAK: "勤務時間に対して休憩時間が長くなっています。打刻内容をご確認ください",
  UNUSUALLY_LONG_WORK: "勤務時間が長くなっています。打刻内容をご確認ください",
};

function reviewReasonText(day) {
  const reasons = [...(day.attendanceReasons ?? []), ...(day.reviewReasons ?? [])];
  const priority = [
    "UNUSUALLY_LONG_BREAK", "UNUSUALLY_LONG_WORK", "UNCLOSED_BREAK", "UNCLOSED_SHIFT",
    "PENDING_CORRECTION", "LOGICAL_CONTRADICTION", "MISSING_DAILY_ATTENDANCE",
  ];
  const reason = priority.find((value) => reasons.includes(value)) ?? reasons[0];
  return reason ? (reviewReasonLabels[reason] ?? "打刻内容をご確認ください") : "";
}

function pillColor(value) {
  if (value.includes("未退勤") || value.includes("未終了") || value.includes("要確認") || value.includes("打刻順序")) return "#b33b2e";
  if (value.includes("GPS")) return "#996b12";
  return NAVY;
}

function drawPill(command, x, y, value, maxWidth = 80) {
  if (!value) return;
  const width = Math.min(maxWidth, Math.max(35, value.length * 6.4 + 11));
  roundedFill(command, x, y, width, 13, 6.5, pillColor(value));
  cellText(command, x, y, width, 13, value, 6, "#ffffff", true, "center", 2);
}

function drawPillInCell(command, x, y, width, height, value) {
  if (!value) return;
  const pillWidth = Math.min(width - 6, Math.max(35, value.length * 6.4 + 11));
  drawPill(command, x + (width - pillWidth) / 2, y + (height - 13) / 2, value, pillWidth);
}

function drawSummary(command, staff) {
  const boxX = 503;
  const boxY = 523;
  const boxWidth = PAGE_WIDTH - MARGIN - boxX;
  const cellWidth = boxWidth / 4;
  const values = [
    ["出勤日数", `${staff.workDays}日`],
    ["実労働時間", longDuration(staff.workMinutes)],
    ["深夜時間", longDuration(staff.lateNightMinutes)],
    ["休憩時間", longDuration(staff.breakMinutes)],
  ];
  fill(command, boxX, boxY, boxWidth, 36, "#d9d6cc");
  values.forEach(([label, value], index) => {
    const x = boxX + index * cellWidth + 0.7;
    fill(command, x, boxY + 0.7, cellWidth - 1.4, 34.6, BEIGE);
    text(command, x + 8, boxY + 21, label, 6.4, "#666666");
    text(command, x + 8, boxY + 4, value, 10.5, NAVY, true);
  });
}

function drawDocumentHeader(command, report, staff, title) {
  text(command, MARGIN, 527, "店舗", 7.1, "#575757");
  fitText(command, MARGIN + 28, 527, report.storeName, 150, 7.1, 5.25, TEXT, true);
  text(command, MARGIN + 189, 527, "対象期間", 7.1, "#575757");
  fitText(command, MARGIN + 229, 527, displayPeriod(report.period), 123, 6.1, 5.1, TEXT, true);
  text(command, MARGIN + 359, 527, "氏名", 7.1, "#575757");
  fitText(command, MARGIN + 385, 527, staff.name, 82, 7.1, 5.5, TEXT, true);
  drawSummary(command, staff);
  line(command, MARGIN, 517, PAGE_WIDTH - MARGIN, 517, NAVY, 1.5);
  text(command, MARGIN, 557, "ONOGAMI勤怠 ｜ 無料版", 6.75, MUTED, true, { characterSpacing: 0.35 });
  text(command, MARGIN, 538, title, 14.25, NAVY, true);
}

function subtotal(days) {
  return days.reduce((total, day) => {
    if (day?.status !== "CONFIRMED") return total;
    if (day.workedMinutes > 0) total.days += 1;
    total.work += day.workedMinutes;
    total.night += day.lateNightMinutes;
    total.breaks += day.breakMinutes;
    return total;
  }, { days: 0, work: 0, night: 0, breaks: 0 });
}

function drawLedger(command, x, topY, width, dates, byDate) {
  const columns = [width * 0.14, width * 0.13, width * 0.13, width * 0.14, width * 0.12, width * 0.15, width * 0.19];
  const labels = ["日付", "出勤", "退勤", "実労働", "深夜", "休憩合計", "備考"];
  const headerHeight = 18;
  const rowHeight = 17.5;
  fill(command, x, topY - headerHeight, width, headerHeight, LIGHT_BEIGE);
  let cursorX = x;
  labels.forEach((label, index) => {
    cellText(command, cursorX, topY - headerHeight, columns[index], headerHeight, label, 7, TEXT, true);
    cursorX += columns[index];
    if (index < columns.length - 1) line(command, cursorX, topY - headerHeight, cursorX, topY, "#454545", 0.75);
  });
  rect(command, x, topY - headerHeight, width, headerHeight, TEXT, 1.5);
  let y = topY - headerHeight;
  const days = [];
  for (const businessDate of dates) {
    const day = byDate.get(businessDate);
    days.push(day);
    y -= rowHeight;
    if (day && notes(day)) fill(command, x, y, width, rowHeight, FLAG_BG);
    cellText(command, x, y, columns[0], rowHeight, displayDate(businessDate), 7.1, TEXT);
    cursorX = x + columns[0];
    const values = day ? [
        day.checkIn, day.checkOut,
        day.status === "CONFIRMED" ? duration(day.workedMinutes) : "",
        day.status === "CONFIRMED" ? duration(day.lateNightMinutes) : "",
        day.status === "CONFIRMED" ? duration(day.breakMinutes) : "", "",
      ] : ["", "", "", "", "", ""];
    values.forEach((value, valueIndex) => {
      const index = valueIndex + 1;
      cellText(command, cursorX, y, columns[index], rowHeight, value, 7.1, TEXT);
      cursorX += columns[index];
      if (index < columns.length - 1) line(command, cursorX, y, cursorX, y + rowHeight, "#454545", 0.75);
    });
    line(command, x + columns[0], y, x + columns[0], y + rowHeight, "#454545", 0.75);
    line(command, cursorX, y, cursorX, y + rowHeight, "#454545", 0.75);
    if (day && notes(day)) {
      const noteX = x + columns.slice(0, 6).reduce((sum, value) => sum + value, 0);
      drawPillInCell(command, noteX, y, columns[6], rowHeight, notes(day));
    }
    line(command, x, y, x + width, y, "#454545", 0.75);
    rect(command, x, y, width, rowHeight, "#454545", 0.75);
  }
  const total = subtotal(days);
  const totalHeight = 18.5;
  y -= totalHeight;
  fill(command, x, y, width, totalHeight, "#f8f7f2");
  cellText(command, x, y, columns[0], totalHeight, "小計", 7.1, TEXT, true);
  cursorX = x + columns[0] + columns[1] + columns[2];
  const totalValues = [duration(total.work), duration(total.night), duration(total.breaks), ""];
  totalValues.forEach((value, valueIndex) => {
    const index = valueIndex + 3;
    cellText(command, cursorX, y, columns[index], totalHeight, value, 7.1, TEXT, true);
    cursorX += columns[index];
    if (index < columns.length - 1) line(command, cursorX, y, cursorX, y + totalHeight, "#454545", 0.75);
  });
  line(command, x + columns[0], y, x + columns[0], y + totalHeight, "#454545", 0.75);
  line(command, x + columns[0] + columns[1] + columns[2], y, x + columns[0] + columns[1] + columns[2], y + totalHeight, "#454545", 0.75);
  rect(command, x, y, width, totalHeight, TEXT, 1.5);
  return y;
}

function drawFooter(command, staffName, pageNumber, pageCount, label, y) {
  text(command, MARGIN, y, `${label} ｜ ${staffName}`, 5.6, "#888888");
  text(command, PAGE_WIDTH - MARGIN - 54, y, `${pageNumber} / ${pageCount}`, 5.6, "#888888", false, { width: 54, align: "right" });
}

function staffSummaryPage(command, report, staff, pageNumber, pageCount) {
  const allDates = calendarDates(report.period);
  const middle = Math.ceil(allDates.length / 2);
  const left = allDates.slice(0, middle);
  const right = allDates.slice(middle);
  const gap = 9;
  const ledgerWidth = (PAGE_WIDTH - MARGIN * 2 - gap) / 2;
  const byDate = new Map(staff.dailyAttendance.map((day) => [day.businessDate, day]));
  const leftBottom = drawLedger(command, MARGIN, 505, ledgerWidth, left, byDate);
  const rightBottom = drawLedger(command, MARGIN + ledgerWidth + gap, 505, ledgerWidth, right, byDate);
  const bottom = Math.min(leftBottom, rightBottom);
  fill(command, MARGIN, bottom - 31, PAGE_WIDTH - MARGIN * 2, 24, "#f4f6f9");
  fill(command, MARGIN, bottom - 31, 3, 24, NAVY);
  inlineText(command, MARGIN + 9, bottom - 22, [
    { value: "集計: ", bold: true },
    { value: "秒単位の打刻から、日ごと・項目ごとに1回だけ分単位へ四捨五入しています。" },
  ], 6.6, "#575757");
  const footerY = bottom - 47;
  drawFooter(command, staff.name, pageNumber, pageCount, "無料版: 勤怠記録・集計", footerY);
  drawDocumentHeader(command, report, staff, "月次勤怠台帳");
}

function drawDetailHeader(command, x, topY, columns) {
  const labels = ["日付", "出勤", "休憩（開始-終了）", "退勤", "休憩合計", "実働（時間）", "深夜", "備考"];
  fill(command, x, topY - 22, columns.reduce((sum, value) => sum + value, 0), 22, LIGHT_BEIGE);
  let cursorX = x;
  labels.forEach((label, index) => {
    cellText(command, cursorX, topY - 22, columns[index], 22, label, 6.75, TEXT, true);
    cursorX += columns[index];
  });
  line(command, x, topY, PAGE_WIDTH - MARGIN, topY, NAVY, 1.5);
  line(command, x, topY - 22, PAGE_WIDTH - MARGIN, topY - 22, "#a8a8a8");
}

function drawDetailRow(command, x, y, height, columns, day) {
  const bottom = y - height;
  if (notes(day)) fill(command, x, bottom, columns.reduce((sum, value) => sum + value, 0), height, FLAG_BG);
  const breakLines = day.breakPeriods.length ? day.breakPeriods : [""];
  const values = [displayDate(day.businessDate), day.detailCheckIn ?? day.checkIn, null, day.detailCheckOut ?? day.checkOut,
    day.status === "CONFIRMED" ? duration(day.breakMinutes) : "",
    day.status === "CONFIRMED" ? duration(day.workedMinutes) : "",
    day.status === "CONFIRMED" ? duration(day.lateNightMinutes) : "", ""];
  let cursorX = x;
  values.forEach((value, index) => {
    if (index === 2) cellLines(command, cursorX, bottom, columns[index], height, breakLines, 7.15, TEXT, false, "center", 4);
    else if (index < 7) cellText(command, cursorX, bottom, columns[index], height, value, 7.15, TEXT);
    cursorX += columns[index];
  });
  if (notes(day)) {
    const noteX = x + columns.slice(0, 7).reduce((sum, value) => sum + value, 0);
    const reason = reviewReasonText(day);
    if (reason) {
      drawPill(command, noteX + 5, bottom + (height - 13) / 2, "要確認", 46);
      fitText(command, noteX + 56, bottom + (height - 6.5) / 2, reason, columns[7] - 61, 5.8, 4.7, "#6b3028");
    } else {
      drawPillInCell(command, noteX, bottom, columns[7], height, notes(day));
    }
  }
  line(command, x, bottom, PAGE_WIDTH - MARGIN, bottom, "#d6d1c7");
}

function detailPageBase(command, report, staff, detailPage, detailPageCount) {
  drawDocumentHeader(command, report, staff, "個別打刻データ");
  const columns = [74, 61, 150, 61, 70, 76, 58, PAGE_WIDTH - MARGIN * 2 - 550];
  drawDetailHeader(command, MARGIN, 510, columns);
  return { command, columns, y: 488, detailPage, detailPageCount };
}

function detailPageRows(staff) {
  const rows = [...staff.dailyAttendance].sort((a, b) => a.businessDate.localeCompare(b.businessDate));
  const pageRows = [];
  let current = [];
  let used = 0;
  for (const day of rows) {
    const hasReviewReason = (day.attendanceReasons?.length ?? 0) + (day.reviewReasons?.length ?? 0) > 0;
    const height = Math.max(hasReviewReason ? 27 : 21, 14 + Math.max(1, day.breakPeriods.length) * 9);
    if (current.length && used + height > 420) { pageRows.push(current); current = []; used = 0; }
    current.push({ day, height });
    used += height;
  }
  pageRows.push(current);
  return pageRows;
}

function staffDetailPages(doc, report, staff, pageRows, firstPageNumber, pageCount) {
  pageRows.forEach((entries, pageIndex) => {
    doc.addPage();
    const page = detailPageBase(doc, report, staff, pageIndex + 1, pageRows.length);
    if (entries.length === 0) text(page.command, MARGIN + 5, 420, "対象期間に勤怠記録はありません。", 9, "#888888");
    for (const entry of entries) { drawDetailRow(page.command, MARGIN, page.y, entry.height, page.columns, entry.day); page.y -= entry.height; }
    const legendY = Math.max(47, page.y - 25);
    dashedLine(page.command, MARGIN, legendY + 19, PAGE_WIDTH - MARGIN, legendY + 19);
    drawPill(page.command, MARGIN, legendY, "訂正あり", 55);
    text(page.command, MARGIN + 62, legendY + 3.5, "修正履歴", 6.5, "#666666");
    drawPill(page.command, MARGIN + 135, legendY, "GPS確認", 55);
    text(page.command, MARGIN + 197, legendY + 3.5, "位置情報の参考確認", 6.5, "#666666");
    drawPill(page.command, MARGIN + 315, legendY, "要確認", 55);
    text(page.command, MARGIN + 377, legendY + 3.5, "未退勤等", 6.5, "#666666");
    const footerY = Math.max(24, legendY - 18);
    drawFooter(page.command, staff.name, firstPageNumber + pageIndex, pageCount, "無料版: 詳細打刻記録（複数休憩対応）", footerY);
  });
}

function zeroAttendancePage(command, report) {
  const staff = { name: "-", workDays: 0, workMinutes: 0, lateNightMinutes: 0, breakMinutes: 0 };
  drawDocumentHeader(command, report, staff, "月次勤怠台帳");
  fill(command, MARGIN, 360, PAGE_WIDTH - MARGIN * 2, 90, BEIGE);
  text(command, MARGIN + 20, 410, "今回の締め期間には勤怠記録がありませんでした。", 14, NAVY);
  drawFooter(command, "対象スタッフなし", 1, 1, "無料版: 勤怠記録・集計", 24);
}

export async function generateMonthlyAttendancePdf(report) {
  if (!report?.storeName || !report?.period?.start || !report?.period?.end || !Array.isArray(report.staff)) throw new TypeError("Invalid monthly attendance report");
  const doc = new PDFDocument({ size: [PAGE_WIDTH, PAGE_HEIGHT], margin: 0, autoFirstPage: false, compress: true, info: { Title: `${report.storeName} ${report.label ?? ""} 月次勤怠帳票`, Creator: "ONOGAMI勤怠" } });
  doc.registerFont("NotoSansJP-Regular", NOTO_REGULAR);
  doc.registerFont("NotoSansJP-Bold", NOTO_BOLD);
  const chunks = [];
  const completed = new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", resolve);
    doc.on("error", reject);
  });
  if (report.staff.length === 0) {
    doc.addPage();
    zeroAttendancePage(doc, report);
  } else {
    const layouts = report.staff.map((staff) => ({ staff, pageRows: detailPageRows(staff) }));
    const pageCount = layouts.reduce((sum, layout) => sum + 1 + layout.pageRows.length, 0);
    let pageNumber = 0;
    layouts.forEach(({ staff, pageRows }) => {
      doc.addPage();
      pageNumber += 1;
      staffSummaryPage(doc, report, staff, pageNumber, pageCount);
      staffDetailPages(doc, report, staff, pageRows, pageNumber + 1, pageCount);
      pageNumber += pageRows.length;
    });
  }
  doc.end();
  await completed;
  return new Uint8Array(Buffer.concat(chunks));
}
