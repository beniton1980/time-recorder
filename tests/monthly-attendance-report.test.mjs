import assert from "node:assert/strict";
import test from "node:test";
import { buildMonthlyAttendanceReport } from "../lib/monthly-attendance-report.mjs";

test("confirmed work and breaks are totaled while issue days are excluded", () => {
  const events = [
    ["2026-08-24", "CHECK_IN", "2026-08-24T00:00:00Z", "1"],
    ["2026-08-24", "BREAK_START", "2026-08-24T03:00:00Z", "2"],
    ["2026-08-24", "BREAK_END", "2026-08-24T04:00:00Z", "3"],
    ["2026-08-24", "CHECK_OUT", "2026-08-24T09:00:00Z", "4"],
    ["2026-08-25", "CHECK_IN", "2026-08-25T13:00:00Z", "5"],
  ].map(([business_date, event_type, occurred_at, effective_id]) => ({ staff_id: "s1", legal_name: "山田 花子", business_date, event_type, occurred_at, effective_id }));
  const report = buildMonthlyAttendanceReport({ storeName: "店舗", timezone: "Asia/Tokyo", label: "8月度", period: { start: "2026-07-26", end: "2026-08-25" }, generatedAt: new Date("2026-08-26T00:00:00Z"), events, days: [
    { staffId: "s1", businessDate: "2026-08-24", attendanceReasons: [], gpsIssues: [] },
    { staffId: "s1", businessDate: "2026-08-25", attendanceReasons: ["UNCLOSED_SHIFT"], gpsIssues: [] },
  ] });
  assert.equal(report.staff[0].workDuration, "08:00");
  assert.equal(report.staff[0].breakDuration, "01:00");
  assert.equal(report.staff[0].workDays, 1);
  assert.equal(report.staff[0].attendanceIssueDays, 1);
});

