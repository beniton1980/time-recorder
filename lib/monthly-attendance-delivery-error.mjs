const SAFE_DELIVERY_ERROR_CODES = new Set([
  "EMAIL_NOT_CONFIGURED",
  "EMAIL_DELIVERY_FAILED",
  "PDF_REQUIRED",
  "MONTHLY_REPORT_EMAIL_NOT_CONFIGURED",
]);

export function monthlyAttendanceDeliveryErrorCode(error) {
  if (error instanceof Error && SAFE_DELIVERY_ERROR_CODES.has(error.message)) {
    return error.message;
  }

  return "INTERNAL_PROCESSING_FAILED";
}
