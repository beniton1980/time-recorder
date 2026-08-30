import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("payroll console separates calculation, history, and settings", async () => {
  const consolePage = await readFile(new URL("../app/manager/payroll/page.tsx", import.meta.url), "utf8");
  const settingsPage = await readFile(new URL("../app/manager/payroll/settings/page.tsx", import.meta.url), "utf8");

  assert.match(consolePage, /給与コンソール/);
  assert.match(consolePage, /href: "\/manager\/payroll\/preview"/);
  assert.match(consolePage, /href: "\/manager\/payroll\/history"/);
  assert.match(consolePage, /href: "\/manager\/payroll\/settings"/);
  assert.match(settingsPage, /給与設定/);
  assert.doesNotMatch(consolePage, /saveStoreSettings|saveCommutingAllowance/);
});

test("payroll subpages link back to the console and settings explicitly", async () => {
  const previewPage = await readFile(new URL("../app/manager/payroll/preview/page.tsx", import.meta.url), "utf8");
  const historyPage = await readFile(new URL("../app/manager/payroll/history/page.tsx", import.meta.url), "utf8");

  assert.match(previewPage, /href="\/manager\/payroll\/settings"/);
  assert.match(previewPage, /給与コンソールへ戻る/);
  assert.match(historyPage, /給与コンソールへ戻る/);
});
