import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("store settings API restricts closing rules and business-day start", async () => {
  const route = await source("app/api/manager/store-settings/route.ts");
  assert.match(route, /\["month_end", "day_15", "day_25"\]/);
  assert.match(route, /businessDayStartMinute < 0/);
  assert.match(route, /businessDayStartMinute >= 1440/);
});

test("store settings API requires manager access before reading or writing", async () => {
  const route = await source("app/api/manager/store-settings/route.ts");
  assert.match(route, /st\.role = 'MANAGER' OR access\.status = 'active'/);
  assert.match(route, /MANAGER_ACCESS_REQUIRED/);
  assert.match(route, /UPDATE stores/);
});

test("manager dashboard exposes store settings entry point", async () => {
  const link = await source("app/manager/StoreSettingsDashboardLink.tsx");
  assert.match(link, /店舗設定/);
  assert.match(link, /\/manager\/store-settings\?store_id=/);
});

test("store settings page warns before changing closing rule", async () => {
  const page = await source("app/manager/store-settings/page.tsx");
  assert.match(page, /今後の月次集計期間と自動送信日に影響します/);
  assert.match(page, /window\.confirm/);
});
