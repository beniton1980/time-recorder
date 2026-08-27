import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { payrollPeriodForMonth } from "../lib/payroll-default-period.mjs";

test("payroll month maps to store closing period", () => {
  assert.deepEqual(payrollPeriodForMonth("day_25", "2026-08"), { start: "2026-07-26", end: "2026-08-25" });
  assert.deepEqual(payrollPeriodForMonth("month_end", "2026-02"), { start: "2026-02-01", end: "2026-02-28" });
});

test("preview UI uses payroll month instead of asking for raw dates", async () => {
  const page = await readFile(new URL("../app/manager/payroll/preview/page.tsx", import.meta.url), "utf8");
  assert.match(page, /給与月度/);
  assert.match(page, /type="month"/);
  assert.doesNotMatch(page, /開始日<input/);
});

test("payroll settings supports batch holiday and initial wage saves", async () => {
  const page = await readFile(new URL("../app/manager/payroll/page.tsx", import.meta.url), "utf8");
  assert.match(page, /saveHolidayDates/);
  assert.match(page, /法定休日をまとめて登録/);
  assert.match(page, /saveInitialWages/);
  assert.match(page, /入力した時給をまとめて登録/);
});

test("payroll preview gets a wider result layout", async () => {
  const css = await readFile(new URL("../app/manager/payroll/payroll.module.css", import.meta.url), "utf8");
  assert.match(css, /previewPage/);
  assert.match(css, /max-width:\s*1080px/);
});
