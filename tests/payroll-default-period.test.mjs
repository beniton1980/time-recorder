import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { currentPayrollPeriod } from "../lib/payroll-default-period.mjs";

test("month-end closing uses the current calendar month", () => {
  assert.deepEqual(currentPayrollPeriod("month_end", "2026-08-27"), { start: "2026-08-01", end: "2026-08-31" });
});

test("25th closing advances to the next closing period after the 25th", () => {
  assert.deepEqual(currentPayrollPeriod("day_25", "2026-08-25"), { start: "2026-07-26", end: "2026-08-25" });
  assert.deepEqual(currentPayrollPeriod("day_25", "2026-08-27"), { start: "2026-08-26", end: "2026-09-25" });
});

test("15th closing handles a month boundary", () => {
  assert.deepEqual(currentPayrollPeriod("day_15", "2026-08-16"), { start: "2026-08-16", end: "2026-09-15" });
});

test("default-period API stays manager scoped and store-timezone based", async () => {
  const route = await readFile(new URL("../app/api/manager/payroll/default-period/route.ts", import.meta.url), "utf8");
  assert.match(route, /getSql\(\{ mode: "manager", lineIdentity: identity\.sub, storeId: body\.storeId \}\)/);
  assert.match(route, /SELECT closing_rule, timezone/);
  assert.match(route, /todayInTimezone/);
  assert.match(route, /currentPayrollPeriod/);
});

test("preview UI auto-loads the current closing period but keeps manual recalculation", async () => {
  const page = await readFile(new URL("../app/manager/payroll/preview/page.tsx", import.meta.url), "utf8");
  assert.match(page, /payroll\/default-period/);
  assert.match(page, /loadCurrentClosingPeriod\(first\)/);
  assert.match(page, /changeStore/);
  assert.match(page, /過去の期間を確認するときだけ日付を変更/);
  assert.match(page, /再計算/);
});
