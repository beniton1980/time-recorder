export type PayrollSnapshotCsvInput = {
  storeName: string;
  run: { id: string; period_start: string; period_end: string; saved_at: string; version_number: number };
  items: Array<{
    legal_name_snapshot: string;
    hourly_rates_used: unknown;
    minutes_snapshot: Record<string, unknown>;
    components_snapshot: Record<string, unknown>;
    gross_pay_yen: number;
    calculation_spec_version: string;
    source_attendance_spec_versions: unknown;
  }>;
};
export function createPayrollSnapshotCsv(input: PayrollSnapshotCsvInput): string;
