import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("payroll settings API requires manager-scoped database context", async () => {
  const route = await source("app/api/manager/payroll/settings/route.ts");
  assert.match(route, /verifyLineIdToken/);
  assert.match(route, /getSql\(\{ mode: "manager", lineIdentity: identity\.sub, storeId: body\.storeId \}\)/);
  assert.match(route, /enforceRateLimit/);
  assert.doesNotMatch(route, /getSql\(\)/);
});

test("initial wage registration preserves existing history", async () => {
  const route = await source("app/api/manager/payroll/settings/route.ts");
  assert.match(route, /COMPENSATION_HISTORY_EXISTS/);
  assert.match(route, /SELECT 1[\s\S]*FROM payroll_compensation_terms[\s\S]*LIMIT 1/);
  assert.match(route, /createInitialCompensationTerm/);
});

test("legal payroll settings fail closed and remain manager scoped", async () => {
  const route = await source("app/api/manager/payroll/settings/route.ts");
  assert.match(route, /OTHER_REVIEW_REQUIRED/);
  assert.match(route, /PAY_PERIOD/);
  assert.match(route, /CALENDAR_MONTH/);
  assert.match(route, /FIXED_WEEKDAY/);
  assert.match(route, /MANUAL_DATES/);
  assert.match(route, /INVALID_PAYROLL_STORE_SETTINGS/);
  assert.match(route, /payroll_statutory_holidays/);
  assert.match(route, /addStatutoryHolidayDate/);
  assert.match(route, /removeStatutoryHolidayDate/);
  assert.match(route, /WHERE store_id = \$\{storeId\}::uuid/);
});

test("manual statutory holiday save records month confirmation only after date verification", async () => {
  const route = await source("app/api/manager/payroll/settings/route.ts");
  assert.match(route, /STATUTORY_HOLIDAY_SAVE_NOT_VERIFIED/);
  assert.match(route, /INSERT INTO payroll_statutory_holiday_month_confirmations/);
  assert.match(route, /ON CONFLICT \(store_id, holiday_month\) DO UPDATE/);
  assert.match(route, /confirmed_by_line_user_id = EXCLUDED\.confirmed_by_line_user_id/);
  assert.match(route, /statutoryHolidayConfirmedMonths/);
});

test("payroll settings UI explains safe calculation and wage history", async () => {
  const page = await source("app/manager/payroll/settings/page.tsx");
  assert.match(page, /要確認（まだ分からない）/);
  assert.match(page, /給与額は自動確定しません/);
  assert.match(page, /改定日で履歴を分けます/);
  assert.match(page, /過去の時給履歴は保持されています/);
});

test("payroll settings UI makes overtime month and statutory holiday explicit", async () => {
  const page = await source("app/manager/payroll/settings/page.tsx");
  assert.match(page, /月60時間超の残業を数える1か月/);
  assert.match(page, /給与の締め期間と同じ/);
  assert.match(page, /毎月1日〜月末/);
  assert.match(page, /法定休日は「店休日」と同じとは限りません/);
  assert.match(page, /毎週同じ曜日/);
  assert.match(page, /日付を指定する/);
  assert.match(page, /4週4休/);
  assert.match(page, /この月の法定休日をすべて確認しました/);
});

test("payroll legal period migration has safe defaults and consistency constraints", async () => {
  const migration = await source("db/migrations/0032_payroll_legal_period_settings.sql");
  assert.match(migration, /overtime_month_rule TEXT NOT NULL DEFAULT 'OTHER_REVIEW_REQUIRED'/);
  assert.match(migration, /statutory_holiday_rule TEXT NOT NULL DEFAULT 'OTHER_REVIEW_REQUIRED'/);
  assert.match(migration, /statutory_holiday_weekday SMALLINT/);
  assert.match(migration, /payroll_statutory_holiday_rule_consistency/);
  assert.match(migration, /FIXED_WEEKDAY/);
  assert.match(migration, /MANUAL_DATES/);
});
