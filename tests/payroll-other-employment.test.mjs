import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("other-employment confirmation is manager scoped and cannot be deleted by the app", async () => {
  const migration = await source("db/migrations/0036_staff_other_employment_confirmations.sql");
  assert.match(migration, /staff_other_employment_confirmations/);
  assert.match(migration, /NONE.*HAS_OTHER_EMPLOYER.*UNKNOWN/);
  assert.match(migration, /FOR SELECT[\s\S]*app_manager_store_allowed\(store_id\)/);
  assert.match(migration, /FOR INSERT[\s\S]*app_manager_store_allowed\(store_id\)/);
  assert.match(migration, /FOR UPDATE[\s\S]*app_manager_store_allowed\(store_id\)/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE/);
  assert.doesNotMatch(migration, /GRANT[^;]*DELETE/);
});

test("payroll preview fails closed for missing, expired, present, or unknown other employment", async () => {
  const service = await source("lib/payroll-preview-server.ts");
  assert.match(service, /NOW\(\) - INTERVAL '6 months'/);
  assert.match(service, /confirmed_at >= TIMESTAMPTZ '2026-08-29 09:55:00\+00'/);
  assert.match(service, /OTHER_EMPLOYMENT_UNCONFIRMED/);
  assert.match(service, /OTHER_EMPLOYMENT_CONFIRMATION_EXPIRED/);
  assert.match(service, /OTHER_EMPLOYMENT_PRESENT/);
  assert.match(service, /OTHER_EMPLOYMENT_UNKNOWN/);
  assert.match(service, /loadMonthlyAttendance/);
});

test("workplace confirmation includes same-employer stores and invalidates the old question", async () => {
  const page = await source("app/manager/payroll/page.tsx");
  const preview = await source("app/manager/payroll/preview/page.tsx");
  const settings = await source("app/api/manager/payroll/settings/route.ts");
  assert.match(page, /同じ会社の別店舗も含め、この店舗以外で働いているか確認します/);
  assert.match(page, /なし（この店舗だけ）/);
  assert.match(page, /あり（同じ会社の別店舗・別会社）/);
  assert.match(page, /他の店舗・勤務先との労働時間の通算確認が必要/);
  assert.match(preview, /この店舗以外にも勤務先あり（労働時間の通算を要確認）/);
  assert.match(settings, /confirmed_at >= TIMESTAMPTZ '2026-08-29 09:55:00\+00'/);
});

test("manager can confirm other employment at any time and payroll save reuses server preview", async () => {
  const settings = await source("app/api/manager/payroll/settings/route.ts");
  const save = await source("app/api/manager/payroll/save/route.ts");
  assert.match(settings, /confirmOtherEmployment/);
  assert.match(settings, /ON CONFLICT \(store_id, staff_id\) DO UPDATE/);
  assert.match(settings, /confirmed_by_line_user_id/);
  assert.match(save, /calculatePayrollPreviewForStore/);
  assert.match(save, /PAYROLL_REVIEW_REQUIRED/);
});
