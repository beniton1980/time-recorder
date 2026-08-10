import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const applyPath = new URL("../app/onboarding/apply/page.tsx", import.meta.url);
const operatorPath = new URL("../app/operator/onboarding/page.tsx", import.meta.url);
const invitePath = new URL("../app/onboarding/invite/page.tsx", import.meta.url);

test("application screen submits the validated onboarding fields with an idempotency key", async () => {
  const source = await readFile(applyPath, "utf8");
  assert.match(source, /crypto\.randomUUID\(\)/);
  assert.match(source, /\/api\/onboarding\/requests/);
  assert.match(source, /businessDayStartMinute/);
  assert.match(source, /termsAccepted: form\.termsAccepted/);
});

test("operator approval continues to provisioning with a confirmed fallback action", async () => {
  const source = await readFile(operatorPath, "utf8");
  assert.match(source, /requests\/decision/);
  assert.match(source, /requests\/provision/);
  assert.match(source, /承認し、店舗と管理者招待を作成しますか/);
  assert.match(source, /await provision\(item, false\)/);
  assert.match(source, /confirmFirst/);
  assert.match(source, /7日間有効・一度だけ利用可能/);
  assert.match(source, /管理者招待メールを送信しました/);
  assert.match(source, /招待リンクを手動で送ってください/);
});

test("manager registration completion displays and saves the issued store QR as PNG", async () => {
  const source = await readFile(invitePath, "utf8");
  assert.match(source, /data\.storeQr\?\.qrPngDataUrl/);
  assert.match(source, /<img src=\{qrPngDataUrl\}/);
  assert.match(source, /anchor\.href = qrPngDataUrl/);
  assert.match(source, /店舗QRを保存/);
  assert.match(source, /navigator\.share/);
  assert.match(source, /QR管理画面へ/);
  assert.match(source, /QRの自動発行を完了できませんでした/);
  assert.match(source, /QRを発行する/);
});

test("manager invite is claimed only after an explicit user action", async () => {
  const source = await readFile(invitePath, "utf8");
  assert.match(source, /async function claim\(\)/);
  assert.match(source, /onClick=\{\(\)=>void claim\(\)\}/);
  assert.match(source, /manager-invite\/claim/);
  assert.match(source, /MANAGER_INVITE_INVALID/);
  assert.doesNotMatch(source, /void claim\(\);/);
});
