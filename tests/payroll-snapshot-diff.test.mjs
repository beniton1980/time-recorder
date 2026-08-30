import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { comparePayrollSnapshots } from "../lib/payroll-snapshot-diff.mjs";

const minutes = (worked = 0) => ({ worked, statutoryOvertime: 0, highOvertime: 0, statutoryHoliday: 0, lateNight: 0 });
const item = (staff_id, name, gross, worked = 0, adjustments = 0) => ({ staff_id, legal_name_snapshot: name, minutes_snapshot: minutes(worked), components_snapshot: { basePay: gross - adjustments, overtimePremium: 0, highOvertimePremium: 0, statutoryHolidayPremium: 0, lateNightPremium: 0, adjustments }, gross_pay_yen: gross });
const run = (gross) => ({ period_start: "2026-08-01", period_end: "2026-08-31", gross_pay_yen: gross });

test("compares changed, added and removed staff with signed saved-result deltas", () => {
  const result = comparePayrollSnapshots({
    previousRun: run(3000), previousItems: [item("a", "旧名", 1000, 60), item("b", "対象外", 2000, 120)],
    currentRun: run(1700), currentItems: [item("a", "新名", 1200, 90, -100), item("c", "追加", 500, 30)],
  });
  assert.deepEqual(result.summary, { previousGrossPayYen: 3000, currentGrossPayYen: 1700, grossPayDeltaYen: -1300, previousStaffCount: 2, currentStaffCount: 2, changedStaffCount: 1, addedStaffCount: 1, removedStaffCount: 1 });
  assert.equal(result.changes.find((change) => change.staffId === "a").nameChanged, true);
  assert.equal(result.changes.find((change) => change.staffId === "b").grossPayDeltaYen, -2000);
  assert.equal(result.changes.find((change) => change.staffId === "c").status, "ADDED");
});

test("omits unchanged staff and rejects a different period", () => {
  const stable = item("a", "同一", 1000, 60);
  assert.equal(comparePayrollSnapshots({ previousRun: run(1000), previousItems: [stable], currentRun: run(1000), currentItems: [structuredClone(stable)] }).changes.length, 0);
  assert.throws(() => comparePayrollSnapshots({ previousRun: run(1000), previousItems: [stable], currentRun: { ...run(1000), period_end: "2026-09-30" }, currentItems: [stable] }), RangeError);
});

test("fails closed for duplicate staff, malformed values and inconsistent gross totals", () => {
  const valid = item("a", "同一", 1000, 60);
  assert.throws(() => comparePayrollSnapshots({ previousRun: run(2000), previousItems: [valid, valid], currentRun: run(1000), currentItems: [valid] }), /duplicate/);
  assert.throws(() => comparePayrollSnapshots({ previousRun: run(1000), previousItems: [{ ...valid, minutes_snapshot: { ...valid.minutes_snapshot, worked: "60" } }], currentRun: run(1000), currentItems: [valid] }), /Invalid/);
  assert.throws(() => comparePayrollSnapshots({ previousRun: run(999), previousItems: [valid], currentRun: run(1000), currentItems: [valid] }), /Run gross/);
});

test("history comparison is store and period scoped and UI states its safe meaning", async () => {
  const route = await readFile(new URL("../app/api/manager/payroll/history/route.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/manager/payroll/history/page.tsx", import.meta.url), "utf8");
  assert.match(route, /previous\.store_id = \$\{body\.storeId\}::uuid/);
  assert.match(route, /previous\.period_start = \$\{runs\[0\]\.period_start\}::date/);
  assert.match(route, /\(previous\.saved_at, previous\.id\) < /);
  assert.match(route, /comparePayrollSnapshots/);
  assert.match(page, /前回保存版からの変更/);
  assert.match(page, /勤怠の変更履歴や、確定・支払済みを示すものではありません/);
  assert.match(page, /今回の集計対象から外れた/);
  assert.match(page, /税・社会保険・手取り・振込額は含みません/);
});
