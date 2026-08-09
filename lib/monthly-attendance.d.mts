export type ClosingPeriod = { start: string; end: string };

export type EffectivePunch = {
  effective_id: string;
  staff_id: string;
  legal_name?: string;
  business_date: string;
  occurred_at: string | Date;
  event_type: "CHECK_IN" | "BREAK_START" | "BREAK_END" | "CHECK_OUT";
  source?: string | null;
  location_status?: string | null;
  validation_code?: string | null;
};

export type PendingCorrection = { staff_id: string; legal_name?: string; business_date: string };

export type AttendanceDayAssessment = {
  staffId: string;
  legalName?: string;
  businessDate: string;
  attendanceReasons: string[];
  gpsIssues: Array<{ effectiveId: string; reason: string }>;
};

export function closingDay(closingRule: string, year: number, monthIndex: number): number;
export function calculateClosingPeriod(closingRule: string, closingDate: string): ClosingPeriod;
export function classifyGps(event: EffectivePunch): string | null;
export function assessAttendance(
  events: EffectivePunch[],
  pendingCorrections?: PendingCorrection[],
): AttendanceDayAssessment[];
