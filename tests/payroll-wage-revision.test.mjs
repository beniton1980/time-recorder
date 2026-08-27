import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("wage revision closes the current term and creates a new term atomically", async () => {
  const route = await source("app/api/manager/payroll/settings/route.ts");

  assert.match(route, /action === "reviseCompensationTerm"/);
  assert.match(route, /sql\.transaction\(\(tx\) => \[/);
  assert.match(route, /SET effective_to = \$\{body\.effectiveFrom\}::date - 1/);
  assert.match(route, /AND effective_to IS NULL/);
  assert.match(route, /INSERT INTO payroll_compensation_terms/);
  assert.match(route, /created_by_line_user_id/);
});

test("wage revision refuses ambiguous or backwards history changes", async () => {
  const route = await source("app/api/manager/payroll/settings/route.ts");

  assert.match(route, /openRows\.length !== 1/);
  assert.match(route, /COMPENSATION_CURRENT_TERM_REQUIRED/);
  assert.match(route, /body\.effectiveFrom <= current\.effective_from/);
  assert.match(route, /COMPENSATION_REVISION_DATE_INVALID/);
  assert.match(route, /postgresCode\(error\) === "23P01"/);
  assert.match(route, /COMPENSATION_PERIOD_OVERLAP/);
});

test("manager UI explains history-preserving wage revisions", async () => {
  const page = await source("app/manager/payroll/page.tsx");

  assert.match(page, /上書きせず、改定日で履歴を分けます/);
  assert.match(page, /action: "reviseCompensationTerm"/);
  assert.match(page, /過去の時給履歴は保持されています/);
  assert.match(page, /時給履歴を見る/);
});
