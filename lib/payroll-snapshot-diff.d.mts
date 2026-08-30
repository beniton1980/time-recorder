export type SnapshotChange = { key: string; previous: number; current: number; delta: number };
export type PayrollSnapshotComparison = {
  summary: { previousGrossPayYen: number; currentGrossPayYen: number; grossPayDeltaYen: number; previousStaffCount: number; currentStaffCount: number; changedStaffCount: number; addedStaffCount: number; removedStaffCount: number };
  changes: Array<{ staffId: string; status: "ADDED" | "REMOVED" | "CHANGED"; previousName: string | null; currentName: string | null; previousGrossPayYen: number | null; currentGrossPayYen: number | null; grossPayDeltaYen: number; minuteChanges: SnapshotChange[]; componentChanges: SnapshotChange[]; nameChanged: boolean }>;
};
export function comparePayrollSnapshots(input: { previousRun: Record<string, unknown>; previousItems: Array<Record<string, unknown>>; currentRun: Record<string, unknown>; currentItems: Array<Record<string, unknown>> }): PayrollSnapshotComparison;
