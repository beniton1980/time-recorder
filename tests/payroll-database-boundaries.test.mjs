import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("payroll wage data is store-scoped and hidden behind manager RLS", async () => {
  const migration = await source("db/migrations/0031_payroll_terms.sql");

  for (const table of [
    "payroll_store_settings",
    "payroll_compensation_terms",
    "payroll_statutory_holidays",
  ]) {
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} FORCE ROW LEVEL SECURITY`));
  }

  assert.match(migration, /app_manager_store_allowed\(store_id\)/);
  assert.match(migration, /FOREIGN KEY \(staff_id, store_id\)[\s\S]*REFERENCES public\.staff\(id, store_id\)/);
  assert.doesNotMatch(migration, /app_token_store_allowed/);
});

test("payroll terms preserve wage history and reject ambiguous overlapping periods", async () => {
  const migration = await source("db/migrations/0031_payroll_terms.sql");

  assert.match(migration, /effective_from DATE NOT NULL/);
  assert.match(migration, /effective_to DATE/);
  assert.match(migration, /prevent_overlapping_payroll_terms/);
  assert.match(migration, /daterange\(existing\.effective_from/);
  assert.match(migration, /overlapping payroll compensation terms/);
});

test("payroll settings fail closed for unsupported work-time systems", async () => {
  const migration = await source("db/migrations/0031_payroll_terms.sql");

  assert.match(migration, /DEFAULT 'OTHER_REVIEW_REQUIRED'/);
  assert.match(migration, /STANDARD_40H/);
  assert.match(migration, /SPECIAL_44H/);
  assert.match(migration, /OTHER_REVIEW_REQUIRED/);
  assert.match(migration, /week_starts_on SMALLINT/);
});
