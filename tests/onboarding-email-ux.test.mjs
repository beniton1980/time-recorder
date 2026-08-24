import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("onboarding emails explain one next action at each stage", async () => {
  const verify = await source("lib/onboarding/send-contact-email-verification.ts");
  const invite = await source("lib/onboarding/send-manager-invite.ts");
  const ready = await source("lib/onboarding/send-initial-store-qr.ts");

  assert.match(verify, /お申し込みいただきありがとうございます/);
  assert.match(verify, /メールアドレスを確認する/);
  assert.match(verify, /利用開始に必要なご案内/);

  assert.match(invite, /ご利用準備ができました/);
  assert.match(invite, /LINEで管理者登録を開始する/);
  assert.match(invite, /店舗の打刻QRが発行/);

  assert.match(ready, /ONOGAMI勤怠を利用開始できる状態/);
  assert.match(ready, /掲示用チラシを印刷する/);
  assert.match(ready, /締め日後には、月次の勤怠データをメール/);
});

test("store setup email attaches both QR PNG and printable PDF", async () => {
  const mailer = await source("lib/onboarding/send-initial-store-qr.ts");
  assert.match(mailer, /generateStorePosterPdf/);
  assert.match(mailer, /content_type: "image\/png"/);
  assert.match(mailer, /content_type: "application\/pdf"/);
  assert.match(mailer, /-打刻案内\.pdf/);
});

test("staff poster prioritizes self-service correction before manager help", async () => {
  const poster = await source("lib/onboarding/store-poster.mjs");
  assert.match(poster, /スタッフのみなさんへ/);
  assert.match(poster, /出勤・休憩・退勤は/);
  assert.match(poster, /初回だけ氏名を入力する/);
  assert.match(poster, /「打刻を修正する」から修正できます/);
  assert.match(poster, /分からない場合は、店舗の管理者に確認してください/);
});
