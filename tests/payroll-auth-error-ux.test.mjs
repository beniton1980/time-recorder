import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const helperPath = new URL("lib/manager-api-auth-error.ts", root);
const payrollPages = [
  "app/manager/payroll/settings/page.tsx",
  "app/manager/payroll/history/page.tsx",
  "app/manager/payroll/preview/page.tsx",
  "app/manager/payroll/PayrollWeekBoundaryCard.tsx",
];

test("manager API auth errors give distinct recovery guidance", async () => {
  const source = await readFile(helperPath, "utf8");
  assert.match(source, /status === 401/);
  assert.match(source, /INVALID_ID_TOKEN/);
  assert.match(source, /LINEの認証期限が切れました。LINEから画面を開き直してください。/);
  assert.match(source, /status === 403/);
  assert.match(source, /MANAGER_ACCESS_REQUIRED/);
  assert.match(source, /この店舗の管理者権限がありません。管理者アカウントと店舗を確認してください。/);
});

test("all payroll screens use the shared auth error guidance", async () => {
  for (const path of payrollPages) {
    const source = await readFile(new URL(path, root), "utf8");
    assert.match(source, /managerApiAuthError/);
    assert.doesNotMatch(source, /管理者権限を確認できませんでした。/);
  }
});
