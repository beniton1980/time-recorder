import { deriveDailyAttendanceRecords } from "../monthly-attendance.mjs";
import { buildMonthlyAttendanceReport, monthlyAttendanceGpsIssues, monthlyAttendanceIssues, monthlyAttendanceStaffSummaries } from "../monthly-attendance-report.mjs";
import { createMonthlyAttendanceCsv } from "../monthly-attendance-csv.mjs";
import { createMonthlyAttendanceEmail } from "../monthly-attendance-email.mjs";

const event = (store_id, staff_id, legal_name, business_date, effective_id, event_type, occurred_at, extra = {}) => ({
  store_id, staff_id, legal_name, business_date, effective_id, event_type, occurred_at, source: "LIFF", ...extra,
});

// A deliberately synthetic, in-memory scenario. It never reads or writes a store database.
export const testCenterEvents = [
  event("test-store-a", "test-staff-a", "テスト 太郎", "2026-08-01", "a1", "CHECK_IN", "2026-08-01T17:00:00+09:00"),
  event("test-store-a", "test-staff-a", "テスト 太郎", "2026-08-01", "a2", "BREAK_START", "2026-08-01T21:40:00+09:00"),
  event("test-store-a", "test-staff-a", "テスト 太郎", "2026-08-01", "a3", "BREAK_END", "2026-08-01T22:05:00+09:00"),
  event("test-store-a", "test-staff-a", "テスト 太郎", "2026-08-01", "a4", "CHECK_OUT", "2026-08-01T23:15:00+09:00"),
  event("test-store-a", "test-staff-a", "テスト 太郎", "2026-08-02", "a5", "CHECK_IN", "2026-08-02T21:30:00+09:00", { location_status: "WARNING", validation_code: "OUTSIDE_STORE_RADIUS" }),
  event("test-store-a", "test-staff-a", "テスト 太郎", "2026-08-02", "a6", "CHECK_OUT", "2026-08-03T02:30:00+09:00"),
  event("test-store-a", "test-staff-b", "確認 花子", "2026-08-03", "a7", "CHECK_IN", "2026-08-03T18:00:00+09:00"),
  event("test-store-b", "test-staff-a-b", "テスト 太郎", "2026-08-01", "b1", "CHECK_IN", "2026-08-01T12:00:00+09:00"),
  event("test-store-b", "test-staff-a-b", "テスト 太郎", "2026-08-01", "b2", "CHECK_OUT", "2026-08-01T15:00:00+09:00"),
];

export function buildTestCenterScenario() {
  const storeEvents = testCenterEvents.filter((item) => item.store_id === "test-store-a");
  const days = deriveDailyAttendanceRecords(storeEvents);
  const report = buildMonthlyAttendanceReport({
    storeName: "ONOGAMIテスト店舗", timezone: "Asia/Tokyo", label: "08月度（模擬）",
    period: { start: "2026-08-01", end: "2026-08-31" }, generatedAt: new Date("2026-09-01T00:00:00Z"),
    events: storeEvents, days,
  });
  const attendanceIssues = monthlyAttendanceIssues(report);
  const gpsIssues = monthlyAttendanceGpsIssues(report);
  const staffSummaries = monthlyAttendanceStaffSummaries(report);
  const csv = createMonthlyAttendanceCsv(report);
  const email = createMonthlyAttendanceEmail({
    storeName: report.storeName, label: report.label, period: report.period,
    staffCount: report.staff.length, attendanceIssueDays: attendanceIssues.length,
    attendanceIssues, gpsIssueCount: gpsIssues.length, gpsIssues, staffSummaries, acceptanceTest: true,
  });
  return { storeEvents, days, report, attendanceIssues, gpsIssues, staffSummaries, csv, email };
}
