const minuteKeys = ["worked", "statutoryOvertime", "highOvertime", "statutoryHoliday", "lateNight"];

function integer(value, label, { nonNegative = false } = {}) {
  if (!Number.isSafeInteger(value) || (nonNegative && value < 0)) throw new TypeError(`Invalid ${label}`);
  return value;
}

function validateItems(run, items) {
  integer(run.gross_pay_yen, "run gross", { nonNegative: true });
  if (!Array.isArray(items)) throw new TypeError("Invalid payroll items");
  const seen = new Set();
  let total = 0;
  for (const item of items) {
    if (!item || typeof item.staff_id !== "string" || !item.staff_id || seen.has(item.staff_id)) throw new TypeError("Invalid or duplicate staff id");
    seen.add(item.staff_id);
    if (!item.minutes_snapshot || !item.components_snapshot || typeof item.components_snapshot !== "object") throw new TypeError("Invalid payroll snapshot");
    for (const key of minuteKeys) integer(item.minutes_snapshot[key], `minutes.${key}`, { nonNegative: true });
    const entries = Object.entries(item.components_snapshot);
    if (entries.length === 0) throw new TypeError("Empty components snapshot");
    const componentTotal = entries.reduce((sum, [key, value]) => sum + integer(value, `components.${key}`), 0);
    const gross = integer(item.gross_pay_yen, "item gross", { nonNegative: true });
    if (componentTotal !== gross) throw new TypeError("Item gross does not match components");
    total += gross;
  }
  if (total !== run.gross_pay_yen) throw new TypeError("Run gross does not match items");
}

function values(before, after, keys) {
  return keys.flatMap((key) => {
    const previous = before?.[key] ?? 0;
    const current = after?.[key] ?? 0;
    return previous === current ? [] : [{ key, previous, current, delta: current - previous }];
  });
}

export function comparePayrollSnapshots({ previousRun, previousItems, currentRun, currentItems }) {
  if (previousRun.period_start !== currentRun.period_start || previousRun.period_end !== currentRun.period_end) throw new RangeError("Payroll periods differ");
  validateItems(previousRun, previousItems);
  validateItems(currentRun, currentItems);
  const previous = new Map(previousItems.map((item) => [item.staff_id, item]));
  const current = new Map(currentItems.map((item) => [item.staff_id, item]));
  const changes = [];
  for (const staffId of new Set([...previous.keys(), ...current.keys()])) {
    const before = previous.get(staffId) ?? null;
    const after = current.get(staffId) ?? null;
    const minuteChanges = values(before?.minutes_snapshot, after?.minutes_snapshot, minuteKeys);
    const componentKeys = [...new Set([...Object.keys(before?.components_snapshot ?? {}), ...Object.keys(after?.components_snapshot ?? {})])].sort();
    const componentChanges = values(before?.components_snapshot, after?.components_snapshot, componentKeys);
    const nameChanged = Boolean(before && after && before.legal_name_snapshot !== after.legal_name_snapshot);
    if (!before || !after || nameChanged || minuteChanges.length || componentChanges.length) {
      changes.push({
        staffId,
        status: !before ? "ADDED" : !after ? "REMOVED" : "CHANGED",
        previousName: before?.legal_name_snapshot ?? null,
        currentName: after?.legal_name_snapshot ?? null,
        previousGrossPayYen: before?.gross_pay_yen ?? null,
        currentGrossPayYen: after?.gross_pay_yen ?? null,
        grossPayDeltaYen: (after?.gross_pay_yen ?? 0) - (before?.gross_pay_yen ?? 0),
        minuteChanges,
        componentChanges,
        nameChanged,
      });
    }
  }
  const grossPayDeltaYen = currentRun.gross_pay_yen - previousRun.gross_pay_yen;
  if (changes.reduce((sum, change) => sum + change.grossPayDeltaYen, 0) !== grossPayDeltaYen) throw new TypeError("Payroll change total is inconsistent");
  return {
    summary: {
      previousGrossPayYen: previousRun.gross_pay_yen,
      currentGrossPayYen: currentRun.gross_pay_yen,
      grossPayDeltaYen,
      previousStaffCount: previousItems.length,
      currentStaffCount: currentItems.length,
      changedStaffCount: changes.filter((change) => change.status === "CHANGED").length,
      addedStaffCount: changes.filter((change) => change.status === "ADDED").length,
      removedStaffCount: changes.filter((change) => change.status === "REMOVED").length,
    },
    changes,
  };
}
