import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manual holidays use the unified save button but require explicit monthly review", async () => {
  const page = await readFile(new URL("../app/manager/payroll/page.tsx", import.meta.url), "utf8");
  assert.match(page, /statutoryHolidayRule === "MANUAL_DATES" && holidayMonthReviewed/);
  assert.match(page, /この月の法定休日をすべて確認しました/);
  assert.match(page, /setHolidayMonthReviewed\(false\)/);
  assert.match(page, /店舗ルール・週の区切り・法定休日を保存/);
  assert.doesNotMatch(page, />この月の法定休日を保存/);
  assert.doesNotMatch(page, /async function saveHolidayDates/);
});

test("unreviewed manual holiday month does not get silently confirmed", async () => {
  const page = await readFile(new URL("../app/manager/payroll/page.tsx", import.meta.url), "utf8");
  assert.match(page, /法定休日は「この月の法定休日をすべて確認しました」にチェックしていないため更新していません/);
  assert.match(page, /statutoryHolidayConfirmedMonths/);
});
