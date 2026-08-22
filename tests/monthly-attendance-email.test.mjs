import assert from "node:assert/strict";
import test from "node:test";
import { createMonthlyAttendanceEmail, sendMonthlyAttendanceEmail } from "../lib/monthly-attendance-email.mjs";

const mail = {
  storeId: "store-1", storeName: "おのがみ食堂", recipient: "manager@example.com", label: "8月度",
  period: { start: "2026-07-26", end: "2026-08-25" }, staffCount: 8,
  attendanceIssueDays: 0, gpsIssueCount: 0, gpsIssues: [],
  staffSummaries: [{ name: "佐藤 健", workDays: 2, workMinutes: 905, lateNightMinutes: 35 }],
  deliveryVersion: "initial", pdf: new Uint8Array([37, 80, 68, 70]),
};

test("normal, review, and zero-attendance messages are explicit", () => {
  assert.match(createMonthlyAttendanceEmail(mail).subject, /^【確認事項なし】/);
  assert.match(createMonthlyAttendanceEmail({ ...mail, gpsIssueCount: 4, gpsIssues: [{ staffName: "佐藤 健", businessDate: "2026-08-20" }] }).subject, /^【GPS確認1日】/);
  assert.match(createMonthlyAttendanceEmail({ ...mail, attendanceIssueDays: 2 }).subject, /^【要確認2件】/);
  assert.match(createMonthlyAttendanceEmail({ ...mail, staffCount: 0 }).html, /勤怠記録がありませんでした/);
});

test("email contains payroll-ready staff summaries and actionable GPS days", () => {
  const content = createMonthlyAttendanceEmail({
    ...mail,
    gpsIssueCount: 4,
    gpsIssues: [{ staffName: "佐藤 健", businessDate: "2026-08-20" }],
  });
  assert.match(content.html, /スタッフ別月次サマリー/);
  assert.match(content.html, /2日/);
  assert.match(content.html, /15時間05分/);
  assert.match(content.html, /0時間35分/);
  assert.match(content.html, /休憩時間を差し引いて集計/);
  assert.match(content.html, /FREE版では、出退勤時刻の丸め処理/);
  assert.match(content.html, /GPSについて確認する勤務日/);
  assert.match(content.html, /佐藤 健/);
  assert.match(content.html, /2026-08-20/);
  assert.doesNotMatch(content.html, /GPS確認: 4件/);
});

test("attendance issues identify the staff, business date, and reason in the email", () => {
  const content = createMonthlyAttendanceEmail({
    ...mail,
    attendanceIssueDays: 1,
    attendanceIssues: [{ staffName: "佐藤 健", businessDate: "2026-08-20", reasons: ["UNCLOSED_SHIFT"] }],
  });
  assert.match(content.html, /佐藤 健/);
  assert.match(content.html, /2026-08-20/);
  assert.match(content.html, /退勤の打刻がありません/);
});

test("sends the PDF with a deterministic idempotency key", async () => {
  let request;
  const result = await sendMonthlyAttendanceEmail(mail, {
    apiKey: "test-key", domain: "example.com",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
    },
  });
  assert.deepEqual(result, { sent: true, emailId: "email-1" });
  assert.equal(request.init.headers["Idempotency-Key"], "monthly-attendance-store-1-2026-07-26-2026-08-25-initial");
  const body = JSON.parse(request.init.body);
  assert.equal(body.to[0], "manager@example.com");
  assert.equal(body.attachments[0].content, "JVBERg==");
});

test("does not call the provider without configuration or a PDF", async () => {
  assert.deepEqual(await sendMonthlyAttendanceEmail(mail, { apiKey: "", domain: "" }), { sent: false, code: "EMAIL_NOT_CONFIGURED" });
  assert.deepEqual(await sendMonthlyAttendanceEmail({ ...mail, pdf: new Uint8Array() }, { apiKey: "key", domain: "example.com" }), { sent: false, code: "PDF_REQUIRED" });
});

test("provider and network failures remain retryable results", async () => {
  const rejected = await sendMonthlyAttendanceEmail(mail, {
    apiKey: "key", domain: "example.com", fetchImpl: async () => new Response("no", { status: 503 }),
  });
  assert.deepEqual(rejected, { sent: false, code: "EMAIL_DELIVERY_FAILED" });
  const unavailable = await sendMonthlyAttendanceEmail(mail, {
    apiKey: "key", domain: "example.com", fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.deepEqual(unavailable, { sent: false, code: "EMAIL_DELIVERY_FAILED" });
});

test("escapes store-controlled HTML", () => {
  const content = createMonthlyAttendanceEmail({ ...mail, storeName: "<script>alert(1)</script>" });
  assert.doesNotMatch(content.html, /<script>/);
  assert.match(content.html, /&lt;script&gt;/);
});

