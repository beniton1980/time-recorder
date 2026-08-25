import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pagePath = new URL("../app/manager/clock-poster/page.tsx", import.meta.url);
const cssPath = new URL("../app/manager/clock-poster/clock-poster.module.css", import.meta.url);
const qrPagePath = new URL("../app/manager/qr/page.tsx", import.meta.url);
const dashboardPath = new URL("../app/manager/ManagerDashboardEnhancer.tsx", import.meta.url);

test("clock poster requests the active QR through authenticated DISPLAY action", async () => {
  const page = await readFile(pagePath, "utf8");
  assert.match(page, /action: "DISPLAY"/);
  assert.match(page, /liff\.getIDToken\(\)/);
  assert.match(page, /\/api\/manager\/store-qr/);
});

test("legacy and missing QR states guide the manager without silently rotating", async () => {
  const page = await readFile(pagePath, "utf8");
  assert.match(page, /QR_REISSUE_REQUIRED/);
  assert.match(page, /STORE_QR_NOT_ACTIVE/);
  assert.match(page, /一度だけQRの再発行が必要です/);
  assert.doesNotMatch(page, /action: "ROTATE"/);
});

test("poster is portrait-friendly on phones and switches to a bounded wide layout", async () => {
  const css = await readFile(cssPath, "utf8");
  assert.match(css, /width: clamp\(240px, 72vw, 360px\)/);
  assert.match(css, /@media \(min-width: 760px\)/);
  assert.match(css, /grid-template-columns: minmax\(0, 1\.12fr\) minmax\(320px, 0\.88fr\)/);
  assert.match(css, /width: clamp\(300px, 34vw, 460px\)/);
});

test("QR management and manager dashboard both expose the clock poster", async () => {
  const qrPage = await readFile(qrPagePath, "utf8");
  const dashboard = await readFile(dashboardPath, "utf8");
  assert.match(qrPage, /\/clock-poster\?store_id=/);
  assert.match(qrPage, /打刻用掲示を表示/);
  assert.match(dashboard, /dashboardPosterLink/);
  assert.match(dashboard, /\/manager\/clock-poster/);
});
