export const MONTHLY_REPORT_CONSENT_VERSION = "2026-08-21-v1";

export function isConfirmedMonthlyReportRecipient(value: {
  monthly_report_email?: unknown;
  monthly_report_email_verified_at?: unknown;
  monthly_report_email_consented_at?: unknown;
  monthly_report_email_consent_version?: unknown;
}) {
  return typeof value.monthly_report_email === "string"
    && value.monthly_report_email.length > 0
    && value.monthly_report_email_verified_at != null
    && value.monthly_report_email_consented_at != null
    && value.monthly_report_email_consent_version === MONTHLY_REPORT_CONSENT_VERSION;
}
