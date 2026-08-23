export type ClosingPeriod = { start: string; end: string };

export type EffectivePunch = {
  effective_id: string;
  store_id?: string;
  staff_id: string;
  legal_name?: string;
  business_date: string;
  occurred_at: string | Date;
  event_type: "CHECK_IN" | "BREAK_START" | "BREAK_END" | "CHECK_OUT";
  source?: string | null;
  location_status?: string | null;
  validation_code?: string | null;
  corrected?: boolean;
};

export type PendingCorrection = { store_id?: string; staff_id: string; legal_name?: string; business_date: string };

export type AttendanceInterval = { start: string; end: string };

export type AttendanceDayAssessment = {
  storeId?: string;
  staffId: string;
  legalName?: string;
  businessDate: string;
  status: "CONFIRMED" | "NEEDS_REVIEW";
  workIntervals: AttendanceInterval[];
  breakIntervals: AttendanceInterval[];
  workedMinutes: number | null;
  breakMinutes: number | null;
  lateNightMinutes: number | null;
  hasCorrection: boolean;
  attendanceReasons: string[];
  reviewReasons: string[];
  gpsIssues: Array<{ effectiveId: string; reason: string }>;
  sourceEventIds: string[];
  calculationSpecVersion: string;
};

export declare const ATTENDANCE_CALCULATION_SPEC_VERSION: string;
export function closingDay(closingRule: string, year: number, monthIndex: number): number;
export function calculateClosingPeriod(closingRule: string, closingDate: string): ClosingPeriod;
export function classifyGps(event: EffectivePunch): string | null;
export function assessAttendance(
  events: EffectivePunch[],
  pendingCorrections?: PendingCorrection[],
): AttendanceDayAssessment[];
export function deriveDailyAttendanceRecords(
  events: EffectivePunch[],
  pendingCorrections?: PendingCorrection[],
): AttendanceDayAssessment[];
