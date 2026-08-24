import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import QRCode from "qrcode";
import { generateStorePosterPdf } from "../lib/onboarding/store-poster.mjs";

const verificationSource = fs.readFileSync("lib/onboarding/send-contact-email-verification.ts", "utf8");
const inviteSource = fs.readFileSync("lib/onboarding/send-manager-invite.ts", "utf8");
const qrMailSource = fs.readFileSync("lib/onboarding/send-initial-store-qr.ts", "utf8");

test("onboarding emails use newcomer-friendly copy", () => {
  assert.match(verificationSource, /お申し込みいただきありがとうございます/);
  assert.match(verificationSource, /利用開始に必要なご案内/);
  assert.doesNotMatch(verificationSource, /管理者招待や店舗QRは発行されません/);

  assert.match(inviteSource, /ご利用準備ができました/);
  assert.match(inviteSource, /店舗を管理する方のLINEを登録/);
  assert.match(inviteSource, /店舗の打刻QRの発行と管理者画面の利用/);

  assert.match(qrMailSource, /掲示用チラシ（印刷用PDF）/);
  assert.match(qrMailSource, /掲示用チラシを印刷する/);
  assert.match(qrMailSource, /締め日後には、月次の勤怠データをメールでお送りします/);
  assert.match(qrMailSource, /content_type: "application\/pdf"/);
});

test("store poster PDF contains a printable A4 flyer", async () => {
  const qrPngDataUrl = await QRCode.toDataURL("https://example.com/punch");
  const pdf = await generateStorePosterPdf({ storeName: "テスト店舗", qrPngDataUrl });
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 4).toString("ascii"), "%PDF");
  assert.ok(pdf.length > 10_000);
});

const posterSource = fs.readFileSync("lib/onboarding/store-poster.mjs", "utf8");
test("poster directs staff to self-service correction before manager help", () => {
  assert.match(posterSource, /打刻を間違えたとき・忘れたとき/);
  assert.match(posterSource, /「打刻を修正する」から修正できます/);
  assert.match(posterSource, /分からない場合は、店舗の管理者に確認してください/);
});
