import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("acceptance UI uses manager session and selected store", async () => {
  const page = await source("app/manager/monthly-acceptance/page.tsx");
  assert.match(page, /\/api\/manager\/session/);
  assert.match(page, /storeId/);
  assert.match(page, /\/api\/manager\/monthly-attendance\/acceptance-test/);
});

test("acceptance UI requires confirmed recipient and explicit confirmation", async () => {
  const page = await source("app/manager/monthly-acceptance/page.tsx");
  assert.match(page, /monthly_report_email_verified_at/);
  assert.match(page, /monthly_report_email_consented_at/);
  assert.match(page, /window\.confirm/);
  assert.match(page, /disabled=\{sending \|\| !recipientConfirmed \|\| !storeId \|\| !periodEnd\}/);
});

test("acceptance UI creates a unique idempotency request id", async () => {
  const page = await source("app/manager/monthly-acceptance/page.tsx");
  assert.match(page, /requestId: crypto\.randomUUID\(\)/);
  assert.match(page, /通常の月次自動送信や配信履歴には影響しません/);
});

test("acceptance UI derives the closing date from the selected store rule", async () => {
  const page = await source("app/manager/monthly-acceptance/page.tsx");
  const dashboard = await source("app/api/manager/dashboard/route.ts");
  assert.match(dashboard, /s\.closing_rule/);
  assert.match(page, /closing_rule: string/);
  assert.match(page, /closingDateForMonth/);
  assert.match(page, /day_\(\\d\{1,2\}\)/);
  assert.match(page, /この店舗は<strong>\{closingRuleLabel/);
  assert.doesNotMatch(page, /月末締め店舗は月末日を指定してください/);
});

test("acceptance UI gives useful safe errors for each processing stage", async () => {
  const page = await source("app/manager/monthly-acceptance/page.tsx");
  assert.match(page, /MONTHLY_AGGREGATION_FAILED/);
  assert.match(page, /MONTHLY_PDF_FAILED/);
  assert.match(page, /EMAIL_DELIVERY_FAILED/);
  assert.match(page, /ACCEPTANCE_TEST_UNAVAILABLE/);
});
