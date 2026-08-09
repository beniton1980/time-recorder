const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 42;

function pdfText(value) {
  const bytes = [];
  for (const character of String(value ?? "")) {
    const code = character.codePointAt(0);
    if (code <= 0xffff) bytes.push(code >> 8, code & 0xff);
    else {
      const adjusted = code - 0x10000;
      const high = 0xd800 + (adjusted >> 10);
      const low = 0xdc00 + (adjusted & 0x3ff);
      bytes.push(high >> 8, high & 0xff, low >> 8, low & 0xff);
    }
  }
  return `<${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}>`;
}

function safeNumber(value) {
  return Number.isFinite(value) ? Number(value).toFixed(2).replace(/\.00$/, "") : "0";
}

function text(command, x, y, value, size = 10, color = "0.12 0.22 0.17") {
  command.push(`${color} rg BT /F1 ${size} Tf 1 0 0 1 ${safeNumber(x)} ${safeNumber(y)} Tm ${pdfText(value)} Tj ET`);
}

function line(command, x1, y1, x2, y2, color = "0.78 0.82 0.79") {
  command.push(`${color} RG ${safeNumber(x1)} ${safeNumber(y1)} m ${safeNumber(x2)} ${safeNumber(y2)} l S`);
}

function fill(command, x, y, width, height, color) {
  command.push(`${color} rg ${safeNumber(x)} ${safeNumber(y)} ${safeNumber(width)} ${safeNumber(height)} re f`);
}

function pageHeader(command, report, title, subtitle) {
  fill(command, 0, PAGE_HEIGHT - 92, PAGE_WIDTH, 92, "0.08 0.30 0.20");
  text(command, MARGIN, PAGE_HEIGHT - 48, title, 18, "1 1 1");
  text(command, MARGIN, PAGE_HEIGHT - 72, subtitle, 9, "0.88 0.95 0.91");
  text(command, MARGIN, 26, `${report.storeName}  |  ONOGAMI勤怠`, 8, "0.40 0.47 0.43");
}

function summaryPage(report) {
  const command = [];
  pageHeader(command, report, `${report.storeName}  ${report.label}勤怠表`, `対象期間: ${report.period.start} - ${report.period.end}`);
  const cards = [
    ["スタッフ", `${report.staff.length}名`],
    ["勤怠要確認", `${report.staff.reduce((sum, staff) => sum + staff.attendanceIssueDays, 0)}日分`],
    ["GPS確認", `${report.staff.reduce((sum, staff) => sum + staff.gpsIssueCount, 0)}件`],
  ];
  cards.forEach(([label, value], index) => {
    const x = MARGIN + index * 171;
    fill(command, x, 670, 157, 72, "0.94 0.97 0.95");
    text(command, x + 14, 718, label, 9, "0.30 0.39 0.34");
    text(command, x + 14, 690, value, 18);
  });
  let y = 638;
  text(command, MARGIN, y, "スタッフ別サマリー", 13);
  y -= 26;
  fill(command, MARGIN, y - 8, PAGE_WIDTH - MARGIN * 2, 26, "0.86 0.92 0.88");
  [[0, "スタッフ"], [180, "出勤日数"], [262, "勤務時間"], [350, "休憩時間"], [438, "確認"]].forEach(([offset, label]) => text(command, MARGIN + Number(offset) + 7, y, label, 8));
  y -= 28;
  if (report.staff.length === 0) {
    text(command, MARGIN + 8, y - 12, "今回の締め期間には勤怠記録がありませんでした。", 11);
  } else {
    for (const staff of report.staff) {
      const status = staff.attendanceIssueDays > 0 ? "要確認" : "OK";
      text(command, MARGIN + 7, y, staff.name, 9);
      text(command, MARGIN + 187, y, `${staff.workDays}日`, 9);
      text(command, MARGIN + 269, y, staff.workDuration, 9);
      text(command, MARGIN + 357, y, staff.breakDuration, 9);
      text(command, MARGIN + 445, y, status, 9, status === "OK" ? "0.10 0.42 0.24" : "0.72 0.22 0.12");
      line(command, MARGIN, y - 10, PAGE_WIDTH - MARGIN, y - 10);
      y -= 27;
      if (y < 80) break;
    }
  }
  text(command, MARGIN, 53, `作成日時: ${report.generatedAt}`, 8, "0.40 0.47 0.43");
  return command.join("\n");
}

function staffPage(report, staff) {
  const command = [];
  pageHeader(command, report, staff.name, `${report.label}  |  ${report.period.start} - ${report.period.end}`);
  text(command, MARGIN, 718, `出勤日数  ${staff.workDays}日`, 10);
  text(command, 190, 718, `確定済み勤務  ${staff.workDuration}`, 10);
  text(command, 370, 718, `休憩  ${staff.breakDuration}`, 10);
  text(command, MARGIN, 690, `勤怠要確認  ${staff.attendanceIssueDays}日分`, 10, staff.attendanceIssueDays ? "0.72 0.22 0.12" : "0.10 0.42 0.24");
  text(command, 260, 690, `GPS確認  ${staff.gpsIssueCount}件`, 10);
  let y = 650;
  fill(command, MARGIN, y - 8, PAGE_WIDTH - MARGIN * 2, 26, "0.86 0.92 0.88");
  [[0, "営業日"], [92, "時刻"], [180, "打刻"], [282, "状態"]].forEach(([offset, label]) => text(command, MARGIN + Number(offset) + 7, y, label, 8));
  y -= 28;
  for (const event of staff.events) {
    const marks = [event.corrected ? "訂正" : "", event.gpsIssue ? "※位置確認" : ""].filter(Boolean).join(" / ");
    text(command, MARGIN + 7, y, event.businessDate, 8);
    text(command, MARGIN + 99, y, event.time, 8);
    text(command, MARGIN + 187, y, event.label, 8);
    text(command, MARGIN + 289, y, marks, 8, event.gpsIssue ? "0.72 0.22 0.12" : "0.30 0.39 0.34");
    line(command, MARGIN, y - 9, PAGE_WIDTH - MARGIN, y - 9);
    y -= 24;
    if (y < 105) break;
  }
  if (staff.attendanceReasons?.length) {
    text(command, MARGIN, 82, `要確認: ${staff.attendanceReasons.join(" / ")}`, 8, "0.72 0.22 0.12");
  }
  return command.join("\n");
}

function object(value) {
  return `${value}\n`;
}

export function generateMonthlyAttendancePdf(report) {
  if (!report?.storeName || !report?.period?.start || !report?.period?.end || !Array.isArray(report.staff)) {
    throw new TypeError("Invalid monthly attendance report");
  }
  const rawPages = [summaryPage(report), ...report.staff.map((staff) => staffPage(report, staff))];
  const pages = rawPages.map((content, index) => {
    const footer = [];
    text(footer, PAGE_WIDTH - MARGIN - 36, 26, `${index + 1} / ${rawPages.length}`, 8, "0.40 0.47 0.43");
    return `${content}\n${footer.join("\n")}`;
  });
  const objects = [];
  const add = (value) => (objects.push(value), objects.length);
  const catalog = add("");
  const pagesObject = add("");
  const font = add("<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UTF16-H /DescendantFonts [4 0 R] >>");
  add("<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> >>");
  const pageIds = [];
  for (const pageContent of pages) {
    const contentBytes = new TextEncoder().encode(pageContent);
    const contentId = add(`<< /Length ${contentBytes.length} >>\nstream\n${pageContent}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentId} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObject} 0 R >>`;
  objects[pagesObject - 1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  let pdf = "%PDF-1.7\n%ONOGAMI\n";
  const offsets = [0];
  objects.forEach((value, index) => {
    offsets.push(new TextEncoder().encode(pdf).length);
    pdf += `${index + 1} 0 obj\n${object(value)}endobj\n`;
  });
  const xref = new TextEncoder().encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

