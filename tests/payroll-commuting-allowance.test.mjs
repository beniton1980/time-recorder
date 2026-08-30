import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { calculateCommutingAllowance } from "../lib/payroll-commuting-allowance.mjs";

const term = (method, amountYen, extra = {}) => ({ id: "term-1", method, amountYen, effectiveFrom: "2026-01-01", effectiveTo: null, basisConfirmed: true, ...extra });

test("monthly pass is added once without automatic proration", () => {
  const result = calculateCommutingAllowance({ terms: [term("MONTHLY_PASS", 8000)], payableDates: ["2026-08-01", "2026-08-02"], periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.amountYen, 8000);
  assert.deepEqual(result.snapshot, { method: "MONTHLY_PASS", unitAmountYen: 8000, payableDayCount: 2, termIds: ["term-1"] });
});

test("distance-based gas allowance follows actual payable days", () => {
  const result = calculateCommutingAllowance({ terms: [term("PER_WORKDAY_GAS", 350)], payableDates: ["2026-08-01", "2026-08-03", "2026-08-04"], periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  assert.equal(result.amountYen, 1050);
  assert.equal(result.snapshot.payableDayCount, 3);
});

test("commuting allowance fails closed when its basis or period is unclear", () => {
  const unconfirmed = calculateCommutingAllowance({ terms: [term("MONTHLY_PASS", 8000, { basisConfirmed: false })], payableDates: ["2026-08-01"], periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  assert.equal(unconfirmed.status, "NEEDS_REVIEW");
  const partial = calculateCommutingAllowance({ terms: [term("MONTHLY_PASS", 8000, { effectiveFrom: "2026-08-15" })], payableDates: ["2026-08-20"], periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  assert.equal(partial.status, "NEEDS_REVIEW");
  const noAttendance = calculateCommutingAllowance({ terms: [term("MONTHLY_PASS", 8000)], payableDates: [], periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  assert.deepEqual(noAttendance.reviewReasons, ["COMMUTING_MONTHLY_PASS_NO_ATTENDANCE"]);
});

test("commuting allowance persistence is manager scoped, effective dated and snapshotted", async () => {
  const migration = await readFile(new URL("../db/migrations/0036_payroll_commuting_allowance_terms.sql", import.meta.url), "utf8");
  const settings = await readFile(new URL("../app/api/manager/payroll/settings/route.ts", import.meta.url), "utf8");
  const save = await readFile(new URL("../app/api/manager/payroll/save/route.ts", import.meta.url), "utf8");
  assert.match(migration, /payroll_commuting_allowance_terms_manager_scope/);
  assert.match(migration, /app_manager_store_allowed\(store_id\)/);
  assert.match(migration, /EXCLUDE USING gist/);
  assert.match(migration, /commuting_allowance_snapshot JSONB/);
  assert.match(settings, /basis_confirmed/);
  assert.match(settings, /COMMUTING_ALLOWANCE_REVISION_DATE_INVALID/);
  assert.match(save, /commutingAllowance/);
});

test("commuting UI separates monthly pass and per-workday gas without tax claims", async () => {
  const settings = await readFile(new URL("../app/manager/payroll/page.tsx", import.meta.url), "utf8");
  const preview = await readFile(new URL("../app/manager/payroll/preview/page.tsx", import.meta.url), "utf8");
  assert.match(settings, /1か月の定期代/);
  assert.match(settings, /出勤日ごとのガソリン代/);
  assert.match(settings, /税務上の非課税判定は行いません/);
  assert.match(settings, /実際の定期代に基づく金額です/);
  assert.match(preview, /定期代（月額・自動日割りなし）/);
});
