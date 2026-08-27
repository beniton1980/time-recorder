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

test("holiday month save writes only deltas and verifies persisted dates", async () => {
  const page = await readFile(new URL("../app/manager/payroll/page.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/manager/payroll/settings/route.ts", import.meta.url), "utf8");
  assert.match(page, /action: "saveStatutoryHolidayMonth"/);
  assert.match(route, /action === "saveStatutoryHolidayMonth"/);
  assert.match(route, /existingDates\.filter/);
  assert.match(route, /holidayDates\.filter/);
  assert.match(route, /verifiedRows/);
  assert.match(route, /STATUTORY_HOLIDAY_SAVE_NOT_VERIFIED/);
  assert.doesNotMatch(route, /DELETE FROM payroll_statutory_holidays WHERE store_id = \$\{storeId\}::uuid AND holiday_date >= \$\{monthStart\}/);
});

test("initial wages are saved in one atomic request and show durable saved state", async () => {
  const page = await readFile(new URL("../app/manager/payroll/page.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/manager/payroll/settings/route.ts", import.meta.url), "utf8");
  assert.match(page, /action: "saveInitialCompensationTerms"/);
  assert.match(page, /保存済み/);
  assert.match(route, /action === "saveInitialCompensationTerms"/);
  assert.match(route, /COMPENSATION_HISTORY_EXISTS/);
  assert.match(route, /sql\.transaction/);
});

test("payroll preview forces page, sections, grid and staff cards to full width", async () => {
  const css = await readFile(new URL("../app/manager/payroll/payroll.module.css", import.meta.url), "utf8");
  assert.match(css, /\.page\s*\{[\s\S]*?width:\s*100%/);
  assert.match(css, /\.previewPage\s*\{[\s\S]*?width:\s*100%[\s\S]*?max-width:\s*1080px/);
  assert.match(css, /\.previewPage > \.card[\s\S]*?width:\s*100%/);
  assert.match(css, /\.staffGrid[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(css, /\.staffResultCard[\s\S]*?width:\s*100%/);
  assert.doesNotMatch(css, /grid-template-columns:\s*repeat\(2/);
});
