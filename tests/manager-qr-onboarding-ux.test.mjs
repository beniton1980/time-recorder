import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("manager onboarding and QR navigation stay inside LIFF", async () => {
  const provision = await source(
    "app/api/operator/onboarding/requests/provision/route.ts",
  );
  const invite = await source("app/onboarding/invite/page.tsx");
  const manager = await source("app/manager/page.tsx");
  const qrManager = await source("app/manager/qr/page.tsx");

  assert.match(provision, /https:\/\/liff\.line\.me\/\$\{LIFF_ID\}\/onboarding\/invite/);
  assert.match(invite, /MANAGER_LIFF_URL/);
  assert.match(invite, /MANAGER_QR_LIFF_URL/);
  assert.match(manager, /MANAGER_QR_LIFF_URL/);
  assert.match(qrManager, /MANAGER_LIFF_URL/);
  assert.doesNotMatch(invite, /href="\/manager\/qr"/);
});

test("initial QR completion uses a bounded preview and separated actions", async () => {
  const page = await source("app/onboarding/invite/page.tsx");
  const styles = await source("app/onboarding/onboarding.module.css");

  assert.match(page, /styles\.qrPreview/);
  assert.match(page, /styles\.completionActions/);
  assert.match(styles, /\.qrPreview\{width:min\(100%,320px\)/);
  assert.match(styles, /\.completionActions\{display:grid;gap:14px/);
});

test("manager invitation explains the LINE launch flow", async () => {
  const mailer = await source("lib/onboarding/send-manager-invite.ts");

  assert.match(mailer, /LINEで管理者登録を開始する/);
  assert.match(mailer, /スマートフォンでこのリンクを開くとLINEが起動します/);
});

test("initial QR is generated, downloaded, and emailed as PNG", async () => {
  const claim = await source(
    "app/api/onboarding/manager-invite/claim/route.ts",
  );
  const page = await source("app/onboarding/invite/page.tsx");
  const mailer = await source("lib/onboarding/send-initial-store-qr.ts");

  assert.match(claim, /QRCode\.toDataURL/);
  assert.match(claim, /qrPngDataUrl/);
  assert.match(claim, /logServerError\("initial_store_qr_email_delivery_failed"\)/);
  assert.match(page, /navigator\.canShare\(\{ files: \[imageFile\] \}\)/);
  assert.match(page, /navigator\.share/);
  assert.match(page, /anchor\.href = qrPngDataUrl/);
  assert.match(page, /長押しして画像を保存/);
  assert.match(page, /打刻QR\.png/);
  assert.match(page, /店舗QRを保存/);
  assert.doesNotMatch(page, /店舗QRをPNGで保存/);
  assert.match(mailer, /Idempotency-Key/);
  assert.match(mailer, /onboarding-store-qr-/);
  assert.match(mailer, /attachments/);
  assert.match(mailer, /content_type: "image\/png"/);
  assert.match(mailer, /data:image\/png;base64,/);
  assert.match(mailer, /LINEで管理者画面を開く/);
  assert.match(mailer, /打刻修正申請の承認/);
  assert.match(claim, /\/manager\?store_id=/);
  assert.doesNotMatch(mailer, /image\/svg\+xml/);
});

test("operator approval requires verified email before provisioning", async () => {
  const page = await source("app/operator/onboarding/page.tsx");

  assert.match(page, /if \(decision === "APPROVED"\) \{/);
  assert.match(page, /await requestEmailVerification\(item\)/);
  assert.match(page, /async function provision\(item: Item, confirmFirst = true\)/);
  assert.match(page, /!item\.contact_email_verified_at/);
  assert.match(page, /承認し、連絡先メールの所有確認を送信しますか/);
});


test("newly registered store is selected after membership validation", async () => {
  const claim = await source(
    "app/api/onboarding/manager-invite/claim/route.ts",
  );
  const invite = await source("app/onboarding/invite/page.tsx");
  const qrManager = await source("app/manager/qr/page.tsx");

  assert.match(invite, /data\.manager\.storeId/);
  assert.match(invite, /store_id=\$\{encodeURIComponent\(storeId\)\}/);
  assert.match(invite, /href=\{managerUrl\}>管理者画面へ/);
  assert.match(claim, /store_id=\$\{encodeURIComponent\(result\.store_id\)\}/);
  assert.match(qrManager, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(qrManager, /item\.store_id === requestedStoreId/);
  assert.match(qrManager, /\?\.store_id \?\? items\[0\]\.store_id/);
  assert.match(qrManager, /href=\{managerUrl\}>管理者画面へ戻る/);
});

test("manager QR save supports iPhone share and long-press fallback", async () => {
  const qrManager = await source("app/manager/qr/page.tsx");
  assert.match(qrManager, /data\.qrPngDataUrl/);
  assert.match(qrManager, /navigator\.canShare\(\{ files: \[imageFile\] \}\)/);
  assert.match(qrManager, /navigator\.share/);
  assert.match(qrManager, /window\.open\(issued\.qrPngDataUrl/);
  assert.match(qrManager, /<img src=\{issued\.qrPngDataUrl\}/);
  assert.match(qrManager, /長押しして保存/);
  assert.match(qrManager, /qrResultRef\.current\?\.scrollIntoView\(\{ behavior: "smooth", block: "nearest" \}\)/);
  assert.match(qrManager, /<h2>現在のQR<\/h2>/);
  assert.match(qrManager, /QR画像を保存・共有<\/button>[\s\S]*className=\{styles\.imagePreview\}[\s\S]*下のQR画像を長押し/);
  assert.match(qrManager, /安全のためサーバーに元データを保存しておらず、再表示できません/);
  assert.match(qrManager, /発行日時：/);
  assert.doesNotMatch(qrManager, /function downloadSvg/);
});

test("A4 QR guide is generated as a shareable and long-press saveable image", async () => {
  const qrManager = await source("app/manager/qr/page.tsx");
  assert.match(qrManager, /canvas\.width = 1240/);
  assert.match(qrManager, /canvas\.height = 1754/);
  assert.match(qrManager, /context\.drawImage\(qrImage/);
  assert.match(qrManager, /navigator\.canShare\(\{ files: \[guideFile\] \}\)/);
  assert.match(qrManager, /<img src=\{a4PngDataUrl\}/);
  assert.match(qrManager, /A4案内画像を保存・共有/);
  assert.match(qrManager, /a4PreviewRef\.current\?\.scrollIntoView/);
  assert.doesNotMatch(qrManager, /window\.open\(guideDataUrl/);
  assert.match(qrManager, /A4案内画像を作成しました。下の画像を長押しして保存してください。/);
  assert.doesNotMatch(qrManager, /function printA4/);
});

test("manager QR screen explains the complete leak response without changing the A4 guide", async () => {
  const qrManager = await source("app/manager/qr/page.tsx");
  const styles = await source("app/manager/qr/qr.module.css");

  assert.match(qrManager, /QRが外部に漏れた・紛失したとき/);
  assert.match(qrManager, /新しいQRの発行と同時に、古いQRは使えなくなります/);
  assert.match(qrManager, /現在のQRを無効化/);
  assert.match(qrManager, /心当たりのないスタッフ登録がないか確認/);
  assert.match(qrManager, /そのスタッフを利用停止/);
  assert.match(qrManager, /\{hasActiveQr && <section className=\{styles\.incidentGuide\}/);
  assert.match(styles, /\.incidentGuide\{/);
  assert.match(qrManager, /canvas\.width = 1240/);
  assert.match(qrManager, /canvas\.height = 1754/);
});
