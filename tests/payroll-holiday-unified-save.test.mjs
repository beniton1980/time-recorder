import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manual holidays are saved only through the unified store save button", async () => {
  const page = await readFile(new URL("../app/manager/payroll/page.tsx", import.meta.url), "utf8");
  assert.match(page, /statutoryHolidayRule === "MANUAL_DATES"[\s\S]*saveStatutoryHolidayMonth/);
  assert.match(page, /店舗ルールと法定休日を保存/);
  assert.doesNotMatch(page, />この月の法定休日を保存</);
  assert.doesNotMatch(page, /async function saveHolidayDates/);
});
