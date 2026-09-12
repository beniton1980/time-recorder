import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("store settings only writes the closing rule and rejects stale settings", async () => {
  const route = await source("app/api/manager/store-settings/route.ts");
  assert.match(route, /\["month_end", "day_15", "day_25"\]/);
  assert.doesNotMatch(route, /body\.businessDayStartMinute/);
  assert.match(route, /STORE_SETTINGS_CHANGED/);
  assert.match(route, /expectedClosingRule/);
});

test("store settings writes use a manager-scoped security-definer function", async () => {
  const route = await source("app/api/manager/store-settings/route.ts");
  const migration = await source("db/migrations/0037_manager_store_settings.sql");
  assert.match(route, /set_manager_store_settings/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /app_manager_store_allowed\(p_store_id\)/);
  assert.match(migration, /app_request_setting\(''store_id''\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.set_manager_store_settings/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.set_manager_store_settings/);
});

test("store settings API requires manager access before reading or writing", async () => {
  const route = await source("app/api/manager/store-settings/route.ts");
  assert.match(route, /st\.role = 'MANAGER' OR access\.status = 'active'/);
  assert.match(route, /MANAGER_ACCESS_REQUIRED/);
});

test("manager dashboard exposes store settings entry point", async () => {
  const link = await source("app/manager/page.tsx");
  assert.match(link, /店舗設定/);
  assert.match(link, /\/manager\/store-settings\?store_id=/);
});

test("store settings page warns before changing closing rule", async () => {
  const page = await source("app/manager/store-settings/page.tsx");
  assert.match(page, /今後の月次集計期間と自動送信日に影響します/);
  assert.match(page, /window\.confirm/);
});


test("settings login uses the canonical LIFF entry and preserves the store", async () => {
  const page = await source("app/manager/store-settings/page.tsx");
  const entry = await source("app/liff-entry/page.tsx");
  assert.doesNotMatch(page, /liff\.login/);
  assert.match(page, /entry=store-settings&store_id=/);
  assert.match(entry, /entry === "store-settings"/);
  assert.match(page, /managerApiAuthError/);
  assert.match(page, /isConfirmedMonthlyReportRecipient/);
});
