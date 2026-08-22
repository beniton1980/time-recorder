import type { AttendanceDayAssessment, EffectivePunch } from "./monthly-attendance.mjs";
import type { MonthlyAttendancePdfReport } from "./monthly-attendance-pdf.mjs";

export function buildMonthlyAttendanceReport(input: {
  storeName: string;
  timezone: string;
  label: string;
  period: { start: string; end: string };
  generatedAt: Date;
  events: Array<EffectivePunch & { legal_name: string; corrected?: boolean }>;
  days: AttendanceDayAssessment[];
}): MonthlyAttendancePdfReport;

export function monthlyAttendanceIssues(report: MonthlyAttendancePdfReport): Array<{
  staffName: string;
  businessDate: string;
  reasons: string[];
}>;

export function monthlyAttendanceGpsIssues(report: MonthlyAttendancePdfReport): Array<{
  staffName: string;
  businessDate: string;
}>;

export function monthlyAttendanceStaffSummaries(report: MonthlyAttendancePdfReport): Array<{
  name: string;
  workDays: number;
  workMinutes: number;
  lateNightMinutes: number;
}>;

