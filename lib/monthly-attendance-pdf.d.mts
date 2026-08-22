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
  workMinutes: number;
  breakMinutes: number;
  lateNightMinutes: number;
  workDuration: string;
  breakDuration: string;
  lateNightDuration: string;
  attendanceIssueDays: number;
  gpsIssueCount: number;
  attendanceReasons?: string[];
  dailyAttendance: Array<{
    businessDate: string;
    status: "CONFIRMED" | "NEEDS_REVIEW";
    workedMinutes: number | null;
    breakMinutes: number | null;
    lateNightMinutes: number | null;
    attendanceReasons: string[];
    reviewReasons: string[];
    gpsIssueCount: number;
    hasCorrection: boolean;
    workIntervals: Array<{ start: string; end: string }>;
    breakIntervals: Array<{ start: string; end: string }>;
    checkIn: string;
    checkOut: string;
    detailCheckIn: string;
    detailCheckOut: string;
    breakPeriods: string[];
    workedDuration?: string;
    breakDuration?: string;
    lateNightDuration?: string;
  }>;
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
): Promise<Uint8Array>;

