import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { deriveDailyAttendanceRecords } from "../lib/monthly-attendance.mjs";
import { generateMonthlyAttendancePdf } from "../lib/monthly-attendance-pdf.mjs";
import { buildMonthlyAttendanceReport } from "../lib/monthly-attendance-report.mjs";
import { monthlyAttendanceV1Events } from "./fixtures/monthly-attendance-v1.mjs";

const base = {
  storeName: "おのがみ食堂",
  label: "8月度",
  period: { start: "2026-07-26", end: "2026-08-25" },
  generatedAt: "2026-08-26 09:00",
};

test("creates a valid landscape PDF with individual summary and detail pages", async () => {
  const pdf = await generateMonthlyAttendancePdf({ ...base, staff: [{ name: "山田 花子", workDays: 1, workMinutes: 480, breakMinutes: 60, lateNightMinutes: 0, workDuration: "08:00", breakDuration: "01:00", lateNightDuration: "00:00", attendanceIssueDays: 0, gpsIssueCount: 1, attendanceReasons: [], dailyAttendance: [{ businessDate: "2026-08-25", status: "CONFIRMED", workedMinutes: 480, breakMinutes: 60, lateNightMinutes: 0, attendanceReasons: [], gpsIssueCount: 1, hasCorrection: false, workIntervals: [], breakIntervals: [], checkIn: "09:00", checkOut: "18:00", breakPeriods: ["12:00-13:00"] }], events: [{ businessDate: "2026-08-25", time: "09:00", label: "出勤", corrected: false, gpsIssue: true }] }] });
  const source = Buffer.from(pdf).toString("latin1");
  assert.match(source, /^%PDF-/);
  assert.match(source, /\/Count 2/);
  assert.match(source, /\/MediaBox \[0 0 841\.89 595\.28\]/);
  assert.match(source, /\/FontFile[23]/);
  assert.match(source, /\/ToUnicode/);
  assert.doesNotMatch(source, /\/UniJIS-UTF16-H|HeiseiKakuGo/);
  assert.match(source, /%%EOF\n$/);
});

test("creates a zero-attendance summary PDF", async () => {
  const source = Buffer.from(await generateMonthlyAttendancePdf({ ...base, staff: [] })).toString("latin1");
  assert.match(source, /\/Count 1/);
});

test("rejects incomplete report input", async () => {
  await assert.rejects(generateMonthlyAttendancePdf({}), /Invalid monthly attendance report/);
});

test("fixture PDF uses confirmed daily records and produces no store summary page", async () => {
  const events = monthlyAttendanceV1Events.filter((event) => event.store_id === "store-a");
  const report = buildMonthlyAttendanceReport({
    storeName: "小料理屋ひなた",
    timezone: "Asia/Tokyo",
    label: "2026年8月度",
    period: { start: "2026-08-01", end: "2026-08-31" },
    generatedAt: new Date("2026-09-01T00:00:00Z"),
    events,
    days: deriveDailyAttendanceRecords(events),
  });
  assert.deepEqual(report.staff.map((staff) => ({ work: staff.workMinutes, breaks: staff.breakMinutes, night: staff.lateNightMinutes })), [
    { work: 1620, breaks: 165, night: 340 },
    { work: 510, breaks: 30, night: 420 },
  ]);
  const source = Buffer.from(await generateMonthlyAttendancePdf(report)).toString("latin1");
  assert.match(source, /\/Count 4/);
  assert.match(source, /\/FontFile[23]/);
  assert.doesNotMatch(source, /\/UniJIS-UTF16-H|HeiseiKakuGo/);
});

test("production PDF source omits debug copy and uses global page numbering", async () => {
  const source = await readFile(new URL("../lib/monthly-attendance-pdf.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /自動検算/);
  assert.match(source, /pageCount/);
  assert.match(source, /staff\.name/);
  assert.match(source, /detailCheckIn/);
  assert.match(source, /日ごと・項目ごとに1回だけ分単位へ四捨五入/);
  assert.match(source, /const SUMMARY_BG = "#edf4ee"/);
  assert.match(source, /const SUMMARY_LABEL = "#405449"/);
  assert.match(source, /align: "right"/);
});

