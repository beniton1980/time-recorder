import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { currentPayrollPeriod, payrollPeriodForMonth } from "../lib/payroll-default-period.mjs";

test("month-end closing uses the current calendar month", () => {
  assert.deepEqual(currentPayrollPeriod("month_end", "2026-08-27"), { start: "2026-08-01", end: "2026-08-31" });
});

test("period helper can still resolve the active next period after closing", () => {
  assert.deepEqual(currentPayrollPeriod("day_25", "2026-08-25"), { start: "2026-07-26", end: "2026-08-25" });
  assert.deepEqual(currentPayrollPeriod("day_25", "2026-08-27"), { start: "2026-08-26", end: "2026-09-25" });
});

test("15th closing handles a month boundary", () => {
  assert.deepEqual(currentPayrollPeriod("day_15", "2026-08-16"), { start: "2026-08-16", end: "2026-09-15" });
});

test("explicit payroll month resolves to the store closing period", () => {
  assert.deepEqual(payrollPeriodForMonth("day_25", "2026-08"), { start: "2026-07-26", end: "2026-08-25" });
});

test("default-period API starts from the current calendar month, not the next active closing period", async () => {
  const route = await readFile(new URL("../app/api/manager/payroll/default-period/route.ts", import.meta.url), "utf8");
  assert.match(route, /getSql\(\{ mode: "manager", lineIdentity: identity\.sub, storeId: body\.storeId \}\)/);
  assert.match(route, /SELECT closing_rule, timezone/);
  assert.match(route, /todayInTimezone/);
  assert.match(route, /today\.slice\(0, 7\)/);
  assert.doesNotMatch(route, /currentPeriod\.end\.slice\(0, 7\)/);
  assert.match(route, /payrollPeriodForMonth/);
});

test("preview UI auto-loads the current payroll month and lets managers move between months", async () => {
  const page = await readFile(new URL("../app/manager/payroll/preview/page.tsx", import.meta.url), "utf8");
  assert.match(page, /payroll\/default-period/);
  assert.match(page, /loadPayrollMonth\(first\)/);
  assert.match(page, /changeStore/);
  assert.match(page, /changePayrollMonth/);
  assert.match(page, /shiftMonth\(payrollMonth, -1\)/);
  assert.match(page, /shiftMonth\(payrollMonth, 1\)/);
  assert.doesNotMatch(page, /type="month"/);
});