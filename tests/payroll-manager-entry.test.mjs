import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manager dashboard exposes payroll through LIFF instead of a bare web URL", async () => {
  const source = await readFile(new URL("../app/manager/ManagerDashboardEnhancer.tsx", import.meta.url), "utf8");
  assert.match(source, /https:\/\/liff\.line\.me\/\$\{LIFF_ID\}\/manager\/payroll/);
  assert.match(source, /給与集計を開く/);
  assert.match(source, /LINE認証で給与集計画面を開く/);
});
