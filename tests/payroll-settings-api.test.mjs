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

test("payroll settings UI explains safe calculation and wage history", async () => {
  const page = await source("app/manager/payroll/page.tsx");
  assert.match(page, /要確認（まだ分からない）/);
  assert.match(page, /給与額は自動確定しません/);
  assert.match(page, /改定日で履歴を分けます/);
  assert.match(page, /過去月の再集計に以前の時給を使える/);
});
