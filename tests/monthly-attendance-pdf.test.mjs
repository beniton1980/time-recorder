import assert from "node:assert/strict";
import test from "node:test";
import { generateMonthlyAttendancePdf } from "../lib/monthly-attendance-pdf.mjs";

const base = {
  storeName: "縺翫・縺後∩鬟溷・,
  label: "8譛亥ｺｦ",
  period: { start: "2026-07-26", end: "2026-08-25" },
  generatedAt: "2026-08-26 09:00",
};

test("creates a valid PDF with summary and one page per staff", () => {
  const pdf = generateMonthlyAttendancePdf({ ...base, staff: [{ name: "螻ｱ逕ｰ 闃ｱ蟄・, workDays: 1, workDuration: "08:00", breakDuration: "01:00", attendanceIssueDays: 0, gpsIssueCount: 1, attendanceReasons: [], events: [{ businessDate: "2026-08-25", time: "09:00", label: "蜃ｺ蜍､", corrected: false, gpsIssue: true }] }] });
  const source = new TextDecoder().decode(pdf);
  assert.match(source, /^%PDF-1\.7/);
  assert.match(source, /\/Count 2/);
  assert.match(source, /\/UniJIS-UTF16-H/);
  assert.match(source, /%%EOF\n$/);
});

test("creates a zero-attendance summary PDF", () => {
  const source = new TextDecoder().decode(generateMonthlyAttendancePdf({ ...base, staff: [] }));
  assert.match(source, /\/Count 1/);
});

test("rejects incomplete report input", () => {
  assert.throws(() => generateMonthlyAttendancePdf({}), /Invalid monthly attendance report/);
});

