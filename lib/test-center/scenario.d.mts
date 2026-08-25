export type TestCenterScenario = {
  storeEvents: Array<Record<string, unknown>>;
  days: Array<Record<string, unknown> & { status: string }>;
  report: Record<string, unknown> & { staff: Array<unknown>; storeName: string; label: string; period: { start: string; end: string } };
  attendanceIssues: Array<unknown>;
  gpsIssues: Array<unknown>;
  staffSummaries: Array<unknown>;
  csv: string;
  email: { subject: string; html: string };
};
export declare const testCenterEvents: Array<Record<string, unknown> & { store_id: string }>;
export function buildTestCenterScenario(): TestCenterScenario;
