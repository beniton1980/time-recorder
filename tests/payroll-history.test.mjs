import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("saved payroll history is read-only and store scoped", async () => {
  const route = await source("app/api/manager/payroll/history/route.ts");
  assert.match(route, /getSql\(\{ mode: "manager"/);
  assert.match(route, /WHERE r\.store_id = \$\{body\.storeId\}::uuid AND r\.id = \$\{body\.runId\}::uuid/);
  assert.match(route, /WHERE store_id = \$\{body\.storeId\}::uuid AND payroll_run_id = \$\{body\.runId\}::uuid/);
  assert.doesNotMatch(route, /INSERT INTO|UPDATE payroll_|DELETE FROM payroll_/);
});

test("manager can open saved payroll runs and staff breakdowns", async () => {
  const page = await source("app/manager/payroll/history/page.tsx");
  assert.match(page, /保存済み給与/);
  assert.match(page, /period_start/);
  assert.match(page, /saved_at/);
  assert.match(page, /gross_pay_yen/);
  assert.match(page, /スタッフ別内訳/);
});
