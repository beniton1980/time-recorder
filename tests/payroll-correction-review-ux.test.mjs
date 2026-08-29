import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("attendance screens prevent horizontal drift", async () => {
  const listCss = await source("app/manager/staff-attendance/staff-attendance.module.css");
  const editCss = await source("app/manager/staff-attendance/edit/edit.module.css");
  for (const css of [listCss, editCss]) {
    assert.match(css, /max-width:100vw/);
    assert.match(css, /box-sizing:border-box/);
    assert.match(css, /overflow-x:(?:clip|hidden)/);
    assert.match(css, /overscroll-behavior-x:none/);
  }
});

test("correction reasons are selected and added punches default to manager confirmation", async () => {
  const page = await source("app/manager/staff-attendance/edit/page.tsx");
  assert.match(page, /打刻忘れ/);
  assert.match(page, /端末・通信の不具合/);
  assert.match(page, /打刻時刻の誤り/);
  assert.match(page, /重複打刻/);
  assert.match(page, /operation: "ADD"[\s\S]*reasonChoice: "管理者確認による追加"/);
  assert.match(page, /reasonChoice === "その他"/);
});

test("correction confirmation uses an in-page review instead of browser confirm", async () => {
  const page = await source("app/manager/staff-attendance/edit/page.tsx");
  assert.match(page, /修正内容の確認/);
  assert.match(page, /戻って修正/);
  assert.match(page, /この内容で確定/);
  assert.match(page, /document\.activeElement/);
  assert.doesNotMatch(page, /window\.confirm/);
});

test("attendance navigation has explicit destinations", async () => {
  const editPage = await source("app/manager/staff-attendance/edit/page.tsx");
  const attendancePage = await source("app/manager/staff-attendance/page.tsx");
  assert.match(editPage, /window\.location\.replace\(attendanceHref/);
  assert.match(attendancePage, /href="\/manager"/);
  assert.doesNotMatch(attendancePage, /history\.back\(\)/);
});

test("payroll preview keeps time context inside money breakdown", async () => {
  const page = await source("app/manager/payroll/preview/page.tsx");
  const route = await source("app/api/manager/payroll/preview/route.ts");
  assert.match(page, /要確認なし/);
  assert.doesNotMatch(page, /確認不要/);
  assert.doesNotMatch(page, />時間内訳</);
  assert.match(page, /金額内訳/);
  assert.match(page, /基本給 <small>実働/);
  assert.match(page, /時間外割増 <small>法定時間外/);
  assert.match(page, /月60時間超割増/);
  assert.match(page, /深夜割増 <small>深夜/);
  assert.match(page, /法定休日割増 <small>法定休日/);
  assert.match(page, /加算 .*円\/時/);
  assert.match(page, /期間内で時給変更あり/);
  assert.match(page, /深夜時間は、通常労働・法定時間外・法定休日労働と重複する場合があります/);
  assert.match(route, /hourlyRatesUsed/);
  assert.match(route, /rates:/);
});
