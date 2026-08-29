import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("payroll snapshot tables are append-only and manager scoped", async () => {
  const migration = await readFile(new URL("../db/migrations/0035_payroll_run_snapshots.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE public\.payroll_runs/);
  assert.match(migration, /CREATE TABLE public\.payroll_run_items/);
  assert.match(migration, /settings_snapshot JSONB NOT NULL/);
  assert.match(migration, /hourly_rates_used JSONB NOT NULL/);
  assert.match(migration, /minutes_snapshot JSONB NOT NULL/);
  assert.match(migration, /components_snapshot JSONB NOT NULL/);
  assert.match(migration, /calculation_spec_version TEXT NOT NULL/);
  assert.match(migration, /source_attendance_spec_versions JSONB NOT NULL/);
  assert.match(migration, /FOR SELECT[\s\S]*app_manager_store_allowed\(store_id\)/);
  assert.match(migration, /FOR INSERT[\s\S]*app_manager_store_allowed\(store_id\)/);
  assert.match(migration, /GRANT SELECT, INSERT ON public\.payroll_runs TO onogami_app/);
  assert.match(migration, /GRANT SELECT, INSERT ON public\.payroll_run_items TO onogami_app/);
  assert.doesNotMatch(migration, /GRANT[^;]*(UPDATE|DELETE)[^;]*payroll_runs/);
  assert.doesNotMatch(migration, /GRANT[^;]*(UPDATE|DELETE)[^;]*payroll_run_items/);
});

test("save API recalculates on server and rejects review-required payroll", async () => {
  const route = await readFile(new URL("../app/api/manager/payroll/save/route.ts", import.meta.url), "utf8");
  assert.match(route, /calculatePayrollPreviewForStore/);
  assert.match(route, /PAYROLL_REVIEW_REQUIRED/);
  assert.match(route, /preview\.summary\.needsReviewCount > 0/);
  assert.match(route, /WITH new_run AS/);
  assert.match(route, /INSERT INTO payroll_runs/);
  assert.match(route, /INSERT INTO payroll_run_items/);
  assert.match(route, /jsonb_array_elements/);
  assert.match(route, /settingsSnapshot/);
  assert.match(route, /sourceAttendanceSpecVersions/);
  assert.doesNotMatch(route, /UPDATE payroll_runs|DELETE FROM payroll_runs/);
});

test("save UI is disabled until all payroll review items are resolved", async () => {
  const page = await readFile(new URL("../app/manager/payroll/preview/page.tsx", import.meta.url), "utf8");
  assert.match(page, /preview\.summary\.needsReviewCount > 0/);
  assert.match(page, /要確認を解消してから保存/);
  assert.match(page, /この給与集計結果を保存/);
  assert.match(page, /\/api\/manager\/payroll\/save/);
  assert.match(page, /保存直前の再計算で要確認事項が見つかりました/);
});
