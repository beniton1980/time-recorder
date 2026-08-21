import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTENDANCE_CALCULATION_SPEC_VERSION,
  deriveDailyAttendanceRecords,
} from "../lib/monthly-attendance.mjs";
import { buildMonthlyAttendanceReport } from "../lib/monthly-attendance-report.mjs";
import {
  monthlyAttendanceV1Events,
  monthlyAttendanceV1Expected,
} from "./fixtures/monthly-attendance-v1.mjs";

const records = deriveDailyAttendanceRecords(monthlyAttendanceV1Events);
const byDay = new Map(records.map((record) => [
  `${record.storeId}:${record.staffId}:${record.businessDate}`,
  record,
]));

test("daily attendance v1 covers multiple breaks, late-night breaks, midnight, and 05:00", () => {
  assert.deepEqual(
    pick(byDay.get("store-a:sato-a:2026-08-01")),
    { status: "CONFIRMED", workedMinutes: 330, breakMinutes: 45, lateNightMinutes: 70 },
  );
  assert.deepEqual(
    pick(byDay.get("store-a:sato-a:2026-08-02")),
    { status: "CONFIRMED", workedMinutes: 270, breakMinutes: 30, lateNightMinutes: 240 },
  );
  assert.deepEqual(
    pick(byDay.get("store-a:suzuki-a:2026-08-01")),
    { status: "CONFIRMED", workedMinutes: 390, breakMinutes: 30, lateNightMinutes: 390 },
  );
  assert.deepEqual(
    pick(byDay.get("store-a:suzuki-a:2026-08-02")),
    { status: "CONFIRMED", workedMinutes: 120, breakMinutes: 0, lateNightMinutes: 30 },
  );
});

test("unclosed shifts and breaks remain null instead of becoming zero", () => {
  const unclosedShift = byDay.get("store-a:sato-a:2026-08-05");
  assert.equal(unclosedShift.status, "NEEDS_REVIEW");
  assert.equal(unclosedShift.workedMinutes, null);
  assert.match(unclosedShift.attendanceReasons.join(" "), /UNCLOSED_SHIFT/);

  const unclosedBreak = byDay.get("store-a:suzuki-a:2026-08-03");
  assert.equal(unclosedBreak.status, "NEEDS_REVIEW");
  assert.equal(unclosedBreak.breakMinutes, null);
  assert.match(unclosedBreak.attendanceReasons.join(" "), /UNCLOSED_BREAK/);
});

test("corrections and GPS warnings remain separate from confirmation", () => {
  const corrected = byDay.get("store-a:sato-a:2026-08-06");
  assert.equal(corrected.status, "CONFIRMED");
  assert.equal(corrected.hasCorrection, true);
  assert.equal(corrected.lateNightMinutes, 30);

  const gpsWarning = byDay.get("store-a:sato-a:2026-08-07");
  assert.equal(gpsWarning.status, "CONFIRMED");
  assert.equal(gpsWarning.gpsIssues.length, 1);
  assert.equal(gpsWarning.workedMinutes, 240);
});

test("monthly aggregates are sums of confirmed daily records and stay store-separated", () => {
  const actual = {};
  for (const record of records) {
    const key = `${record.storeId}:${record.staffId}`;
    actual[key] ??= { workDays: 0, workedMinutes: 0, breakMinutes: 0, lateNightMinutes: 0, needsReview: 0 };
    if (record.status === "NEEDS_REVIEW") actual[key].needsReview += 1;
    else {
      if (record.workedMinutes > 0) actual[key].workDays += 1;
      actual[key].workedMinutes += record.workedMinutes;
      actual[key].breakMinutes += record.breakMinutes;
      actual[key].lateNightMinutes += record.lateNightMinutes;
    }
  }
  assert.deepEqual(actual, monthlyAttendanceV1Expected);
});

test("the monthly report consumes daily records as its only totals source", () => {
  const storeEvents = monthlyAttendanceV1Events.filter((event) => event.store_id === "store-a");
  const storeRecords = records.filter((record) => record.storeId === "store-a");
  const report = buildMonthlyAttendanceReport({
    storeName: "小料理屋ひなた",
    timezone: "Asia/Tokyo",
    label: "8月度",
    period: { start: "2026-08-01", end: "2026-08-31" },
    generatedAt: new Date("2026-09-01T00:00:00Z"),
    events: storeEvents,
    days: storeRecords,
  });
  const sato = report.staff.find((staff) => staff.name === "佐藤 健");
  const suzuki = report.staff.find((staff) => staff.name === "鈴木 葵");
  assert.deepEqual(
    { workDays: sato.workDays, work: sato.workMinutes, breaks: sato.breakMinutes, late: sato.lateNightMinutes, review: sato.attendanceIssueDays },
    { workDays: 5, work: 1620, breaks: 165, late: 340, review: 1 },
  );
  assert.deepEqual(
    { workDays: suzuki.workDays, work: suzuki.workMinutes, breaks: suzuki.breakMinutes, late: suzuki.lateNightMinutes, review: suzuki.attendanceIssueDays },
    { workDays: 2, work: 510, breaks: 30, late: 420, review: 1 },
  );
  assert.ok(report.staff.every((staff) => staff.dailyAttendance.length > 0));
});

test("daily derivation is deterministic and versioned", () => {
  assert.equal(ATTENDANCE_CALCULATION_SPEC_VERSION, "2026-08-21-v1");
  assert.deepEqual(deriveDailyAttendanceRecords(monthlyAttendanceV1Events), records);
  assert.ok(records.every((record) => record.calculationSpecVersion === ATTENDANCE_CALCULATION_SPEC_VERSION));
});

function pick(record) {
  return {
    status: record.status,
    workedMinutes: record.workedMinutes,
    breakMinutes: record.breakMinutes,
    lateNightMinutes: record.lateNightMinutes,
  };
}
