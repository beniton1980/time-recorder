export type CorrectionReceipt = {
  storeId: string;
  staffId: string;
  businessDate: string;
  operation: "ADD" | "REPLACE" | "VOID";
};

const receiptPrefix = "onogami.manager-correction-return.";
const maxAge = 30 * 60 * 1000;

export function isAttendanceDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function attendanceReturnHref(receipt: Omit<CorrectionReceipt, "operation">, reviewOnly: boolean, receiptId?: string) {
  const params = new URLSearchParams({
    store_id: receipt.storeId, staff_id: receipt.staffId,
    month: receipt.businessDate.slice(0, 7), focus: receipt.businessDate,
  });
  if (reviewOnly) params.set("review", "1");
  if (receiptId) params.set("saved", receiptId);
  return `/manager/staff-attendance?${params}`;
}

// A successful API response is the only producer. A URL alone never claims a save.
// Storage failure must not turn an acknowledged save into an apparent failure.
export function rememberCorrection(receipt: CorrectionReceipt): string | undefined {
  try {
    const id = crypto.randomUUID();
    window.sessionStorage.setItem(receiptPrefix + id, JSON.stringify({ ...receipt, savedAt: Date.now() }));
    return id;
  } catch { return undefined; }
}

export function consumeCorrectionReceipt(id: string, expected: Omit<CorrectionReceipt, "operation">): CorrectionReceipt | null {
  if (!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(id)) return null;
  try {
    const raw = window.sessionStorage.getItem(receiptPrefix + id);
    window.sessionStorage.removeItem(receiptPrefix + id);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value || value.storeId !== expected.storeId || value.staffId !== expected.staffId
      || value.businessDate !== expected.businessDate || !isAttendanceDate(value.businessDate)
      || !["ADD", "REPLACE", "VOID"].includes(value.operation)
      || typeof value.savedAt !== "number" || !Number.isFinite(value.savedAt)
      || Date.now() - value.savedAt < 0 || Date.now() - value.savedAt > maxAge) return null;
    return { ...expected, operation: value.operation };
  } catch { return null; }
}
