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
  assert.match(claim, /catch \(mailError\)/);
  assert.match(page, /anchor\.href = qrPngDataUrl/);
  assert.match(page, /打刻QR\.png/);
  assert.match(page, /店舗QRをPNGで保存/);
  assert.match(mailer, /Idempotency-Key/);
  assert.match(mailer, /onboarding-store-qr-/);
  assert.match(mailer, /attachments/);
  assert.match(mailer, /content_type: "image\/png"/);
  assert.match(mailer, /data:image\/png;base64,/);
  assert.doesNotMatch(mailer, /image\/svg\+xml/);
});

test("operator approval continues directly to provisioning and invite creation", async () => {
  const page = await source("app/operator/onboarding/page.tsx");

  assert.match(page, /if \(decision === "APPROVED"\) \{/);
  assert.match(page, /await provision\(item, false\)/);
  assert.match(page, /async function provision\(item: Item, confirmFirst = true\)/);
  assert.match(page, /承認し、店舗と管理者招待を作成しますか/);
});
