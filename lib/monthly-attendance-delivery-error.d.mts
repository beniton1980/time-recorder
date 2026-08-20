export function monthlyAttendanceDeliveryErrorCode(error: unknown):
  | "EMAIL_NOT_CONFIGURED"
  | "EMAIL_DELIVERY_FAILED"
  | "PDF_REQUIRED"
  | "MONTHLY_REPORT_EMAIL_NOT_CONFIGURED"
  | "INTERNAL_PROCESSING_FAILED";
