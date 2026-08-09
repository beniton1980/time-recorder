export type PdfPunchEvent = {
  businessDate: string;
  time: string;
  label: string;
  corrected: boolean;
  gpsIssue: boolean;
};

export type PdfStaffSummary = {
  name: string;
  workDays: number;
  workDuration: string;
  breakDuration: string;
  attendanceIssueDays: number;
  gpsIssueCount: number;
  attendanceReasons?: string[];
  events: PdfPunchEvent[];
};

export type MonthlyAttendancePdfReport = {
  storeName: string;
  label: string;
  period: { start: string; end: string };
  generatedAt: string;
  staff: PdfStaffSummary[];
};

export function generateMonthlyAttendancePdf(
  report: MonthlyAttendancePdfReport,
): Uint8Array;

