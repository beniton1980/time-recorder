import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { payrollPeriodForMonth } from "../lib/payroll-default-period.mjs";

test("payroll month maps to store closing period", () => {
  assert.deepEqual(payrollPeriodForMonth("day_25", "2026-08"), { start: "2026-07-26", end: "2026-08-25" });
  assert.deepEqual(payrollPeriodForMonth("month_end", "2026-02"), { start: "2026-02-01", end: "2026-02-28" });
});

test("preview UI changes payroll months without the native month picker", async () => {
  const page = await readFile(new URL("../app/manager/payroll/preview/page.tsx", import.meta.url), "utf8");
  assert.match(page, /前月/);
  assert.match(page, /次月/);
  assert.match(page, /shiftMonth/);
  assert.doesNotMatch(page, /type="month"/);
  assert.doesNotMatch(page, /開始日<input/);
});

test("preview UI can jump directly to a distant payroll month", async () => {
  const page = await readFile(new URL("../app/manager/payroll/preview/page.tsx", import.meta.url), "utf8");
  assert.match(page, /年月を選ぶ/);
  assert.match(page, /この年月を表示/);
  assert.match(page, /jumpToPayrollMonth/);
  assert.match(page, /toPayrollMonth/);
  assert.match(page, /普段は前月・次月で切り替え/);
  assert.doesNotMatch(page, /type="month"/);
});

test("preview UI explains unconfirmed statutory-holiday months and links directly to settings", async () => {
  const page = await readFile(new URL("../app/manager/payroll/preview/page.tsx", import.meta.url), "utf8");
  assert.match(page, /unconfirmedManualHolidayMonths/);
  assert.match(page, /法定休日の確認が必要です/);
  assert.match(page, /今回の給与集計に必要な期間が月をまたいでいるため/);
  assert.match(page, /給与設定で確認する/);
  assert.match(page, /href="\/manager\/payroll\/settings"/);
});

test("statutory holiday review checkbox is visually separated from the calendar", async () => {
  const css = await readFile(new URL("../app/manager/payroll/payroll.module.css", import.meta.url), "utf8");
  assert.match(css, /\.calendarGrid \+ \.label\s*\{[\s\S]*?margin-top:\s*16px/);
});

test("manual holiday dates are saved from the single store-rules save action", async () => {
  const page = await readFile(new URL("../app/manager/payroll/settings/page.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/manager/payroll/settings/route.ts", import.meta.url), "utf8");
  assert.match(page, /statutoryHolidayRule === "MANUAL_DATES"[\s\S]*action: "saveStatutoryHolidayMonth"/);
  assert.match(page, /店舗ルール・週の区切り・法定休日を保存/);
  assert.doesNotMatch(page, /この月の法定休日を保存/);
  assert.doesNotMatch(page, /function saveHolidayDates/);
  assert.match(route, /action === "saveStatutoryHolidayMonth"/);
  assert.match(route, /existingDates\.filter/);
  assert.match(route, /holidayDates\.filter/);
  assert.match(route, /verifiedRows/);
  assert.match(route, /STATUTORY_HOLIDAY_SAVE_NOT_VERIFIED/);
});

test("initial wages are saved in one atomic request and show durable saved state", async () => {
  const page = await readFile(new URL("../app/manager/payroll/settings/page.tsx", import.meta.url), "utf8");
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
