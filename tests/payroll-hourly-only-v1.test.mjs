import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("payroll v1 is explicitly limited to hourly-paid staff", async () => {
  const layout = await readFile(new URL("../app/manager/payroll/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /給与集計 v1 は時給制スタッフ専用です/);
  assert.match(layout, /アルバイト・パート等の時給制/);
  assert.match(layout, /日給制・月給制は現在対象外です/);
});

test("payroll compensation settings remain hourly-rate based", async () => {
  const route = await readFile(new URL("../app/api/manager/payroll/settings/route.ts", import.meta.url), "utf8");
  assert.match(route, /hourlyRateYen/);
  assert.match(route, /hourly_rate_yen/);
  assert.doesNotMatch(route, /daily_rate_yen|monthly_salary_yen|compensation_type/);
});
