import assert from "node:assert/strict";
import test from "node:test";
import { deriveDailyAttendanceRecords } from "../lib/monthly-attendance.mjs";
import { buildMonthlyAttendanceReport } from "../lib/monthly-attendance-report.mjs";

test("confirmed work and breaks are totaled while issue days are excluded", () => {
  const events = [
    ["2026-08-24", "CHECK_IN", "2026-08-24T00:00:00Z", "1"],
    ["2026-08-24", "BREAK_START", "2026-08-24T03:00:00Z", "2"],
    ["2026-08-24", "BREAK_END", "2026-08-24T04:00:00Z", "3"],
    ["2026-08-24", "CHECK_OUT", "2026-08-24T09:00:00Z", "4"],
    ["2026-08-25", "CHECK_IN", "2026-08-25T13:00:00Z", "5"],
  ].map(([business_date, event_type, occurred_at, effective_id]) => ({ staff_id: "s1", legal_name: "山田 花子", business_date, event_type, occurred_at, effective_id }));
  const report = buildMonthlyAttendanceReport({ storeName: "店舗", timezone: "Asia/Tokyo", label: "8月度", period: { start: "2026-07-26", end: "2026-08-25" }, generatedAt: new Date("2026-08-26T00:00:00Z"), events, days: deriveDailyAttendanceRecords(events) });
  assert.equal(report.staff[0].workDuration, "08:00");
  assert.equal(report.staff[0].breakDuration, "01:00");
  assert.equal(report.staff[0].workDays, 1);
  assert.equal(report.staff[0].attendanceIssueDays, 1);
});

test("database Date business dates are normalized before report sorting", () => {
  const events = [
    { staff_id: "s1", legal_name: "山田 花子", business_date: new Date("2026-08-24T00:00:00Z"), event_type: "CHECK_IN", occurred_at: "2026-08-24T00:00:00Z", effective_id: "1" },
    { staff_id: "s1", legal_name: "山田 花子", business_date: new Date("2026-08-24T00:00:00Z"), event_type: "CHECK_OUT", occurred_at: "2026-08-24T09:00:00Z", effective_id: "2" },
  ];
  const days = deriveDailyAttendanceRecords(events.map((event) => ({ ...event, business_date: "2026-08-24" })));
  const report = buildMonthlyAttendanceReport({ storeName: "店舗", timezone: "Asia/Tokyo", label: "8月度", period: { start: "2026-07-26", end: "2026-08-25" }, generatedAt: new Date("2026-08-26T00:00:00Z"), events, days });
  assert.equal(report.staff[0].dailyAttendance[0].businessDate, "2026-08-24");
  assert.equal(report.staff[0].events[0].businessDate, "2026-08-24");
});

test("staff with only a pending correction still appears as requiring attention", () => {
  const report = buildMonthlyAttendanceReport({
    storeName: "店舗",
    timezone: "Asia/Tokyo",
    label: "8月度",
    period: { start: "2026-07-26", end: "2026-08-25" },
    generatedAt: new Date("2026-08-26T00:00:00Z"),
    events: [],
    days: deriveDailyAttendanceRecords([], [{
      staff_id: "inactive",
      legal_name: "退職済みスタッフ",
      business_date: "2026-08-10",
    }]),
  });
  assert.equal(report.staff.length, 1);
  assert.equal(report.staff[0].name, "退職済みスタッフ");
  assert.equal(report.staff[0].attendanceIssueDays, 1);
  assert.deepEqual(report.staff[0].events, []);
});

test("plausibility warnings count as review days without removing confirmed totals", () => {
  const events = [
    ["CHECK_IN", "2026-08-10T03:56:00Z", "1"],
    ["BREAK_START", "2026-08-10T03:56:00Z", "2"],
    ["BREAK_END", "2026-08-10T07:31:00Z", "3"],
    ["CHECK_OUT", "2026-08-10T07:33:00Z", "4"],
  ].map(([event_type, occurred_at, effective_id]) => ({ staff_id: "s1", legal_name: "山田 花子", business_date: "2026-08-10", event_type, occurred_at, effective_id }));
  const report = buildMonthlyAttendanceReport({ storeName: "店舗", timezone: "Asia/Tokyo", label: "8月度", period: { start: "2026-07-26", end: "2026-08-25" }, generatedAt: new Date("2026-08-26T00:00:00Z"), events, days: deriveDailyAttendanceRecords(events) });
  assert.equal(report.staff[0].attendanceIssueDays, 1);
  assert.equal(report.staff[0].workMinutes, 2);
  assert.equal(report.staff[0].breakMinutes, 215);
  assert.equal(report.staff[0].dailyAttendance[0].status, "CONFIRMED");
  assert.deepEqual(report.staff[0].dailyAttendance[0].reviewReasons, ["UNUSUALLY_LONG_BREAK"]);
  assert.equal(report.staff[0].events[0].time, "12:56:00");
  assert.equal(report.staff[0].dailyAttendance[0].checkIn, "12:56");
  assert.equal(report.staff[0].dailyAttendance[0].detailCheckIn, "12:56:00");
});
