import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildTestCenterScenario, testCenterEvents } from "../lib/test-center/scenario.mjs";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("test center synthetic scenario reuses attendance and artifact builders", () => {
  const scenario = buildTestCenterScenario();
  assert.equal(scenario.days.filter((day) => day.status === "NEEDS_REVIEW").length, 1);
  assert.equal(scenario.gpsIssues.length, 1);
  assert.match(scenario.csv, /営業日/);
  assert.match(scenario.email.subject, /受入テスト/);
  assert.ok(testCenterEvents.some((item) => item.store_id === "test-store-b"));
  assert.ok(scenario.storeEvents.every((item) => item.store_id === "test-store-a"));
});

test("operator test center is allowlist protected and has no production mutation or email delivery", async () => {
  const run = await source("app/api/operator/test-center/run/route.ts");
  const artifact = await source("app/api/operator/test-center/artifact/route.ts");
  assert.match(run, /verifyOperator\(body\.idToken\)/);
  assert.match(artifact, /verifyOperator\(body\.idToken\)/);
  for (const code of [run, artifact]) {
    assert.doesNotMatch(code, /getSql|sendMonthlyAttendanceEmail|store-qr|RESEND_API_KEY/);
  }
});

test("test center UI names destructive exclusions and manual checks", async () => {
  const page = await source("app/operator/test-center/page.tsx");
  assert.match(page, /安全な全自動テストを実行/);
  assert.match(page, /実メール送信・QR再発行/);
  assert.match(page, /実機確認/);
  assert.match(page, /メール表示/);
  assert.match(page, /PDF表示/);
  assert.match(page, /CSV表示/);
});
