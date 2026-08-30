export type PayrollPreviewContext = {
  queryPeriod: { start: string; end: string };
  payPeriod: { start: string; end: string };
  overtimeMonth: { start: string; end: string };
  weekContextStart: string;
  weekContextComplete: boolean;
  overtimeMonthContextComplete: boolean;
  payPeriodInsideOvertimeMonth: boolean;
  statutoryHolidayDates: string[];
  overtimeRuleSupported: boolean;
  holidayRuleSupported: boolean;
  weekRuleSupported: boolean;
  weekStartsOn: number;
  manualHolidayMonthsComplete: boolean;
  unconfirmedManualHolidayMonths: string[];
};

export type PayrollPreviewSettings = {
  workTimeSystem?: string;
  weekStartRule?: "CALENDAR_DEFAULT" | "EXPLICIT_WEEKDAY" | "OTHER_REVIEW_REQUIRED";
  weekStartsOn?: number;
  overtimeMonthRule?: string;
  statutoryHolidayRule?: string;
  statutoryHolidayWeekday?: number | null;
  overtimePremiumRate?: number;
  highOvertimePremiumRate?: number;
  statutoryHolidayPremiumRate?: number;
  lateNightPremiumRate?: number;
};

export function buildPayrollPreviewContext(input: {
  payPeriodStart: string;
  payPeriodEnd: string;
  settings?: PayrollPreviewSettings;
  manualHolidayDates?: string[];
  manualHolidayConfirmedMonths?: string[];
}): PayrollPreviewContext;

export function calculateStaffPayrollPreview(input: {
  attendanceDays: Array<{
    staffId: string;
    businessDate: string;
    status: "CONFIRMED" | "NEEDS_REVIEW";
    workedMinutes: number | null;
    lateNightMinutes: number | null;
    calculationSpecVersion?: string;
  }>;
  compensationTerms: Array<{
    id?: string;
    hourlyRate: number;
    effectiveFrom: string;
    effectiveTo: string | null;
  }>;
  settings?: PayrollPreviewSettings;
  context: PayrollPreviewContext;
}): {
  status: "CONFIRMED" | "NEEDS_REVIEW";
  reviewReasons: string[];
  minutes: { worked: number; statutoryOvertime: number; highOvertime: number; statutoryHoliday: number; lateNight: number };
  components: { basePay: number; overtimePremium: number; highOvertimePremium: number; statutoryHolidayPremium: number; lateNightPremium: number; adjustments: number; commutingAllowance?: number };
  grossPay: number;
  calculationSpecVersion: string;
  sourceAttendanceSpecVersions: string[];
};
