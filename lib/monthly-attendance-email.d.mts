export type MonthlyAttendanceEmail = {
  storeId: string;
  storeName: string;
  recipient: string;
  label: string;
  period: { start: string; end: string };
  staffCount: number;
  attendanceIssueDays: number;
  attendanceIssues?: Array<{ staffName: string; businessDate: string; reasons: string[] }>;
  gpsIssueCount: number;
  deliveryVersion: string;
  pdf: Uint8Array;
};

export type MonthlyAttendanceEmailResult =
  | { sent: true; emailId: string | null }
  | { sent: false; code: "EMAIL_NOT_CONFIGURED" | "PDF_REQUIRED" | "EMAIL_DELIVERY_FAILED" };

export function createMonthlyAttendanceEmail(mail: MonthlyAttendanceEmail): {
  subject: string;
  html: string;
};

export function sendMonthlyAttendanceEmail(
  mail: MonthlyAttendanceEmail,
  options?: {
    apiKey?: string;
    domain?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<MonthlyAttendanceEmailResult>;

